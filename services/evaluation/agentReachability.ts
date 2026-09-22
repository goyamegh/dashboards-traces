/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fast-fail for unreachable agent endpoints.
 *
 * Owner incident: a 62-case run against an agent whose HTTP endpoint was DOWN
 * (connection refused) took hours. The connector failed instantly on every
 * case — but each case still sat through the full trace-polling window
 * (`TRACE_POLL_INTERVAL_MS × TRACE_POLL_MAX_ATTEMPTS`, 10 min by default)
 * before ending as "Evaluator could not run … trace_timeout", with the real
 * cause (`ECONNREFUSED`) lost. Polling for traces of a request that never
 * left the process is pure waste, and retrying the same dead endpoint 62
 * times is too.
 *
 * Two mechanisms, both generic across connectors:
 *
 *  1. **Transport-failure classification** ({@link classifyTransportFailure}):
 *     recognises errors that mean "the request never reached / was never
 *     served by the agent" — connection refused, DNS failure, reset, TLS
 *     failure, a non-2xx status before any stream started, or a subprocess
 *     that could not be spawned (`ENOENT` for the CLI binary). Timeouts and
 *     in-stream parse errors are NOT transport failures: the agent answered
 *     (or is answering) and normal handling applies.
 *
 *  2. **Per-run circuit breaker** ({@link EndpointCircuitBreaker}): after N
 *     CONSECUTIVE transport failures to the same endpoint (default 3,
 *     `connectorConfig.unreachableThreshold` / `AGENT_UNREACHABLE_THRESHOLD`)
 *     the remaining cases of that run fail immediately with
 *     {@link AgentUnreachableError} instead of each retrying. A success resets
 *     the count, so an endpoint that flaps once is not tripped.
 *
 * The runner turns either error into a FINAL `agent_failed` report (never
 * trace-polled, never judged) — see `finalizeAgentFailedReport` in
 * `services/evaluationRunner.ts` / `services/benchmarkRunner.ts`.
 *
 * Pure and dependency-free so both the server bundle and unit tests can
 * import it; endpoint text is reduced to `host[:port]` so no credentials,
 * paths or query strings ever land on a report.
 */

import { buildEvaluatorErrorPatch } from './evaluatorError';

/** Default number of consecutive transport failures that trips the breaker. */
export const DEFAULT_UNREACHABLE_THRESHOLD = 3;

/** Env override for the per-run breaker threshold (`0` disables). */
export const UNREACHABLE_THRESHOLD_ENV = 'AGENT_UNREACHABLE_THRESHOLD';

/** A classified transport-level failure. */
export interface TransportFailure {
  /**
   * Short machine-readable class: a Node/undici error code (`ECONNREFUSED`,
   * `ENOTFOUND`, `ECONNRESET`, `ENOENT`, …), a TLS code, or `HTTP_<status>`
   * for a non-2xx response before any stream started.
   */
  code: string;
  /** Human-readable description of the failure class. */
  description: string;
  /** HTTP status when the failure was a rejected request. */
  httpStatus?: number;
}

const CONNECTION_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed (temporary)',
  EAI_FAIL: 'DNS lookup failed',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  EHOSTDOWN: 'host down',
  EADDRNOTAVAIL: 'address not available',
  EPIPE: 'connection closed while sending',
  UND_ERR_SOCKET: 'socket error',
  UND_ERR_CONNECT_TIMEOUT: 'connect timeout',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname mismatch',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS self-signed certificate in chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS handshake failed',
  EPROTO: 'TLS/protocol error',
  // Subprocess connectors: the CLI binary could not be started at all.
  ENOENT: 'command not found',
  EACCES: 'permission denied executing command',
  EPERM: 'operation not permitted executing command',
};

/**
 * HTTP statuses that mean "the request was rejected before the agent did any
 * work". 408 (request timeout) and 429 (rate limited) are excluded — both are
 * transient and 429 already has its own backoff in the runners.
 */
function isRejectedStatus(status: number): boolean {
  return status >= 400 && status <= 599 && status !== 408 && status !== 429;
}

/** Walk `error.cause` (bounded), collecting each hop. */
function causeChain(error: unknown): Array<{ code?: string; message: string; status?: number }> {
  const chain: Array<{ code?: string; message: string; status?: number }> = [];
  let current: any = error;
  const seen = new Set<unknown>();
  for (let i = 0; i < 6 && current !== undefined && current !== null && !seen.has(current); i++) {
    seen.add(current);
    if (typeof current === 'string') { chain.push({ message: current }); break; }
    const status = current.httpStatus ?? current.status ?? current.statusCode;
    chain.push({
      code: typeof current.code === 'string' ? current.code : undefined,
      message: typeof current.message === 'string' ? current.message : String(current),
      status: typeof status === 'number' ? status : undefined,
    });
    current = current.cause;
  }
  return chain;
}

// Connectors word rejected responses as "<X> request failed: 503 - body",
// "HTTP 502" or "status 504"; AggregateError from undici wraps ECONNREFUSED
// in its message when `cause` has no code (Node 18).
const STATUS_IN_MESSAGE_RE = /(?:request failed:|HTTP|status(?: code)?)\s*(\d{3})\b/i;
const CODE_IN_MESSAGE_RE = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ENOENT|EACCES|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)\b/;

/**
 * Decide whether an agent-step error is a transport-level failure (the
 * request never reached, or was rejected outright by, the agent). Returns
 * `undefined` for everything else — timeouts, hook errors, parse errors,
 * subprocess non-zero exits — which keep their normal handling.
 */
export function classifyTransportFailure(error: unknown): TransportFailure | undefined {
  if (error === undefined || error === null) return undefined;
  const chain = causeChain(error);

  for (const hop of chain) {
    if (hop.code && CONNECTION_CODES[hop.code]) {
      return { code: hop.code, description: CONNECTION_CODES[hop.code] };
    }
  }
  for (const hop of chain) {
    const m = hop.message.match(CODE_IN_MESSAGE_RE);
    if (m && CONNECTION_CODES[m[1]]) return { code: m[1], description: CONNECTION_CODES[m[1]] };
  }
  for (const hop of chain) {
    const status = hop.status ?? (() => { const m = hop.message.match(STATUS_IN_MESSAGE_RE); return m ? Number(m[1]) : undefined; })();
    if (typeof status === 'number' && isRejectedStatus(status)) {
      return { code: `HTTP_${status}`, description: `endpoint rejected the request with HTTP ${status}`, httpStatus: status };
    }
  }
  return undefined;
}

/**
 * Reduce an endpoint to something safe to put on a report: `host[:port]` for
 * URLs (drops scheme, userinfo, path and query), the bare command for
 * subprocess agents, or the raw string when it is neither.
 */
export function describeEndpointHost(endpoint: string | undefined): string {
  if (!endpoint) return 'unknown endpoint';
  try {
    const url = new URL(endpoint);
    if (url.host) return url.host;
  } catch { /* not a URL */ }
  // A command line: keep only the executable name.
  return endpoint.trim().split(/\s+/)[0] || endpoint;
}

/**
 * Circuit-breaker key for an agent: the endpoint host for HTTP agents, the
 * command for subprocess agents. Two agents sharing a host share a key —
 * intentionally: an unreachable host is unreachable for both.
 */
export function endpointKeyFor(agent: { endpoint?: string; connectorConfig?: Record<string, any> }, effectiveEndpoint?: string): string {
  const endpoint = effectiveEndpoint ?? agent.endpoint;
  if (endpoint && /^https?:\/\//i.test(endpoint)) return describeEndpointHost(endpoint);
  const command = agent.connectorConfig?.command;
  if (typeof command === 'string' && command.trim()) return `command:${command.trim()}`;
  return endpoint ? describeEndpointHost(endpoint) : 'unknown endpoint';
}

/** Strip the `command:` prefix for display. */
function displayKey(key: string): string {
  return key.startsWith('command:') ? key.slice('command:'.length) : key;
}

/**
 * Resolve the breaker threshold: `connectorConfig.unreachableThreshold`
 * (per agent) wins over `AGENT_UNREACHABLE_THRESHOLD` (env) over the default
 * of 3. `0` (or any non-positive value) disables the breaker; non-numeric
 * values are ignored.
 */
export function resolveUnreachableThreshold(
  connectorConfig: Record<string, any> | undefined,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): number {
  const candidates = [connectorConfig?.unreachableThreshold, env[UNREACHABLE_THRESHOLD_ENV]];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    return n <= 0 ? Infinity : Math.floor(n);
  }
  return DEFAULT_UNREACHABLE_THRESHOLD;
}

/**
 * Thrown by `invokeAgent` when a connector call fails at the transport level.
 * The message names the failure class and the endpoint host so the report's
 * failure summary is actionable on its own; `cause` keeps the original error.
 */
export class AgentTransportError extends Error {
  readonly code: string;
  readonly endpoint: string;
  readonly httpStatus?: number;

  constructor(failure: TransportFailure, endpointHost: string, cause: unknown) {
    const original = cause instanceof Error ? cause.message : String(cause);
    super(`${failure.code} — ${failure.description} while calling agent endpoint ${endpointHost}: ${original}`);
    this.name = 'AgentTransportError';
    this.code = failure.code;
    this.endpoint = endpointHost;
    this.httpStatus = failure.httpStatus;
    (this as any).cause = cause;
  }
}

/**
 * Thrown by `invokeAgent` BEFORE calling the connector once the breaker for
 * that endpoint is open. The connector is not invoked at all.
 */
export class AgentUnreachableError extends Error {
  readonly code = 'AGENT_ENDPOINT_UNREACHABLE';
  readonly endpoint: string;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: string;

  constructor(endpointHost: string, consecutiveFailures: number, lastFailureCode: string) {
    super(
      `agent endpoint unreachable — ${consecutiveFailures} consecutive connection failure${consecutiveFailures === 1 ? '' : 's'} ` +
      `(${lastFailureCode}, ${endpointHost}); this case was not attempted`,
    );
    this.name = 'AgentUnreachableError';
    this.endpoint = endpointHost;
    this.consecutiveFailures = consecutiveFailures;
    this.lastFailureCode = lastFailureCode;
  }
}

/** True for either fast-fail error class. */
export function isAgentReachabilityError(error: unknown): error is AgentTransportError | AgentUnreachableError {
  return error instanceof AgentTransportError || error instanceof AgentUnreachableError;
}

export interface CircuitState {
  key: string;
  consecutiveFailures: number;
  lastFailureCode?: string;
  /** Cases refused without calling the agent because the circuit was open. */
  rejected: number;
  open: boolean;
}

/**
 * Per-run consecutive-failure breaker keyed by endpoint. Not shared across
 * runs: a new run is a fresh attempt at the endpoint.
 */
export class EndpointCircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(readonly threshold: number = DEFAULT_UNREACHABLE_THRESHOLD) {}

  /** Breaker disabled (threshold 0 / Infinity): never opens. */
  get enabled(): boolean {
    return Number.isFinite(this.threshold) && this.threshold > 0;
  }

  private circuit(key: string): CircuitState {
    let c = this.circuits.get(key);
    if (!c) {
      c = { key, consecutiveFailures: 0, rejected: 0, open: false };
      this.circuits.set(key, c);
    }
    return c;
  }

  isOpen(key: string): boolean {
    return this.circuits.get(key)?.open ?? false;
  }

  /**
   * Throw {@link AgentUnreachableError} when the circuit for `key` is open.
   * Call before invoking the connector.
   */
  assertClosed(key: string): void {
    const c = this.circuits.get(key);
    if (!c?.open) return;
    c.rejected++;
    throw new AgentUnreachableError(displayKey(key), c.consecutiveFailures, c.lastFailureCode ?? 'connection failure');
  }

  /** The agent answered (well or badly): reset the consecutive count. */
  recordSuccess(key: string): void {
    const c = this.circuits.get(key);
    if (!c) return;
    c.consecutiveFailures = 0;
    c.lastFailureCode = undefined;
    c.open = false;
  }

  /**
   * Record a connector error. Only transport failures count; anything else
   * leaves the circuit untouched (and does NOT reset it — an agent that
   * times out did not prove the endpoint reachable). Returns the classified
   * failure when the error counted.
   */
  recordFailure(key: string, error: unknown): TransportFailure | undefined {
    const failure = classifyTransportFailure(error);
    if (!failure) return undefined;
    const c = this.circuit(key);
    c.consecutiveFailures++;
    c.lastFailureCode = failure.code;
    if (this.enabled && c.consecutiveFailures >= this.threshold) c.open = true;
    return failure;
  }

  /** Snapshot of every circuit that is currently open. */
  openCircuits(): CircuitState[] {
    return [...this.circuits.values()].filter(c => c.open).map(c => ({ ...c }));
  }

  /**
   * One-line run-level summary for the runs list / inspector, or `undefined`
   * when no circuit opened during the run.
   */
  summary(): string | undefined {
    const open = this.openCircuits();
    if (open.length === 0) return undefined;
    return open
      .map(c => {
        const n = c.consecutiveFailures;
        const base = `Agent endpoint unreachable — ${n} consecutive connection failure${n === 1 ? '' : 's'} (${c.lastFailureCode ?? 'connection failure'}, ${displayKey(c.key)})`;
        return c.rejected > 0
          ? `${base}; ${c.rejected} further case${c.rejected === 1 ? ' was' : 's were'} not attempted`
          : base;
      })
      .join(' · ');
  }
}

/**
 * Report shape the runners hand to {@link finalizeAgentFailedReport}: the
 * connector-failure report `runEvaluationWithConnector` returns from its
 * catch (`status: 'failed'`, no `metricsStatus`, reason in
 * `llmJudgeReasoning` as `Evaluation failed: <message>`).
 */
export interface AgentFailedReportLike {
  status?: string;
  metricsStatus?: string;
  llmJudgeReasoning?: string;
  traceError?: string;
  skipJudge?: boolean;
}

const LEGACY_REASON_PREFIX = /^Evaluation failed:\s*/;

/**
 * Make an agent-step failure report FINAL so the runner never trace-polls or
 * judges it.
 *
 * Pre-fix the classic (non-SDK) runner path stamped `metricsStatus:
 * 'pending'` onto every trace-mode report that had none — including the
 * connector-failure report, whose agent request never happened — and then
 * polled for traces for the full budget before erroring the case as a trace
 * timeout (the owner incident: minutes per case against a dead endpoint,
 * real cause lost). Applies the canonical `agent_failed` patch
 * (`metricsStatus: 'error'`, `passFailStatus: null`, honest reasoning) with
 * the connector's message as the reason. No-op for any report that already
 * carries a `metricsStatus` (e.g. a connector catch that stamps it itself) or
 * whose agent step succeeded.
 *
 * @returns true when the report was rewritten.
 */
export function finalizeAgentFailedReport(report: AgentFailedReportLike): boolean {
  if (report.status !== 'failed' || report.metricsStatus !== undefined) return false;
  const reason = (report.llmJudgeReasoning ?? '').replace(LEGACY_REASON_PREFIX, '').trim() || 'agent request failed';
  Object.assign(report, buildEvaluatorErrorPatch('agent_failed', reason));
  report.skipJudge = true;
  return true;
}
