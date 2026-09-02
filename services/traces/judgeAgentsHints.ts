/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derive Strategy C correlation hints (`agents` array) for the agent (trace)
 * judge from a persisted run report.
 *
 * Background (#264): the agent (trace) judge's `query_spans` tool reads
 * `/api/traces` to find the spans it should reason over. Without these hints
 * the route only matches spans whose `gen_ai.request.id` equals
 * agent-health's runId (Strategy B) — i.e. agent-health's OWN eval-emitter
 * spans. Subprocess agents like claude-code emit instrumentation under their
 * own session ids, so they're invisible to Strategy B alone.
 *
 * Forwarding `agents: [{serviceName, startedAt, endedAt}]` lets `/api/traces`
 * union Strategy B with Strategy C (service.name + time-window). This is the
 * same correlation the run-detail Traces tab uses (see
 * components/RunDetailsContent.tsx), extracted here so the trace judge tool
 * and the UI converge on one read-side query.
 *
 * The full unification (one shared `buildSpanQuery(report)` for every
 * caller) is tracked in #264 — this helper is the minimum surgery to make
 * the agent (trace) judge functional in the meantime.
 */

import type { TestCaseRun, ConnectorProtocol } from '@/types';

/**
 * Default `service.name` per connector protocol/key, mirroring `AGENTS.md`'s
 * "Trace correlation conventions" table. Used when the agent config doesn't
 * set an explicit `traceServiceName`. Keyed by `string` rather than
 * `ConnectorProtocol` so user-configured connectors (e.g. `kiro`, which
 * isn't in the upstream union) still resolve to a default.
 */
const PROTOCOL_TO_SERVICE_NAME: Record<string, string> = {
  'claude-code': 'claude-code-agent',
  'kiro': 'kiro-agent',
  'pi': 'pi-agent',
  'agui-streaming': 'observio-sample-agent',
  'subprocess': 'subprocess-agent',
};

/**
 * Connector protocols where agent-health does NOT control (and cannot know)
 * the remote agent's OTel `service.name`. Unlike `claude-code`/`kiro`/`pi`/
 * `agui-streaming`/`subprocess` above — connectors WE wrote, whose spawned
 * process/sample-agent always emits under the same fixed name — these are
 * generic TRANSPORT protocols: `rest`/`openai-compatible`/`langgraph` just
 * describe how the HTTP call is shaped, and ANY third-party agent (with ANY
 * OTel service.name, or none at all) can sit behind one. `strands` is a
 * third-party agent framework we don't control either. `mock` never emits
 * real spans.
 *
 * Root cause (2026-09-01 trace_timeout incident): before this set existed,
 * `resolveAgentServiceName()`'s last-resort `${protocol}-agent` heuristic
 * silently resolved `example-rest-agent` (connectorType `rest`, no
 * `traceServiceName` configured) to the fabricated name `"rest-agent"` —
 * which matches no real span, ever. Strategy C then confidently polled that
 * wrong service.name for the FULL attempt budget (60 attempts / 10 min)
 * every single run, even though the agent's real spans (service.name
 * `"example-agent"`) were landing on the cluster the whole time. A wrong
 * guess here is worse than no guess: `undefined` correctly skips Strategy C
 * and falls back to Strategy A/B/D; a wrong string burns the entire poll
 * budget on a query that can never match.
 */
const UNKNOWN_SERVICE_NAME_PROTOCOLS = new Set<string>([
  'rest',
  'openai-compatible',
  'langgraph',
  'strands',
  'mock',
]);

/** Time-window slack on each side of the run window to absorb clock skew. */
const SLACK_MS = 60_000;

/**
 * Lookback used when `report.performanceMetrics.durationMs` is missing
 * (older runs persisted before that field). Wide enough to cover any
 * realistic run, narrow enough to keep noise on a shared OTel cluster
 * minimal. Mirrors the run-detail Traces tab fallback.
 */
const FALLBACK_LOOKBACK_MS = 30 * 60_000;

export interface JudgeAgentsHint {
  serviceName: string;
  startedAt: number;
  endedAt: number;
  /**
   * Agent-emitted session id (Strategy D). When present, trace queries
   * correlate precisely on `attributes.session.id` (unioned with the
   * service.name + window fallback). Sourced from `report.sessionId`.
   */
  sessionId?: string;
}

/**
 * Resolve the `service.name` an agent emits OTel spans under. Priority:
 *   1. Explicit `agentConfig.traceServiceName` (the per-agent override).
 *   2. Protocol-default from the table above (connectors WE wrote — fixed,
 *      known service.name).
 *   3. `undefined` (+ a loud `console.warn`) for `UNKNOWN_SERVICE_NAME_PROTOCOLS`
 *      (generic transport protocols where the remote service.name is NOT
 *      knowable) — deliberately does NOT fabricate a guessed name. See the
 *      set's doc comment for why a wrong guess is worse than no guess.
 *   4. `<connectorProtocol>-agent` heuristic, but ONLY as a last resort for
 *      connector protocol strings outside both of the above (e.g. a
 *      user-configured custom connector key not in the upstream
 *      `ConnectorProtocol` union) — kept for backward compatibility since
 *      those are genuinely unknown rather than known-unknowable.
 *   5. `<agentKey>-agent` as a final guess when protocol itself is unknown.
 *
 * Returns `undefined` when none of the above is derivable; the caller
 * should then skip Strategy C and fall back to Strategy B alone.
 */
export function resolveAgentServiceName(args: {
  agentTraceServiceName?: string;
  connectorProtocol?: ConnectorProtocol;
  agentKey?: string;
}): string | undefined {
  if (args.agentTraceServiceName) return args.agentTraceServiceName;
  if (args.connectorProtocol && PROTOCOL_TO_SERVICE_NAME[args.connectorProtocol]) {
    return PROTOCOL_TO_SERVICE_NAME[args.connectorProtocol];
  }
  if (args.connectorProtocol && UNKNOWN_SERVICE_NAME_PROTOCOLS.has(args.connectorProtocol)) {
    // Loud and always-on (not gated behind a debug flag): silent wrong-name
    // polling is exactly what caused the 2026-09-01 trace_timeout incident
    // to go unnoticed for as long as it did. Surfacing this at resolve time
    // (every poll attempt, not just once) means it shows up immediately in
    // server logs for anyone running useTraces:true against a REST/
    // openai-compatible/langgraph/strands agent without traceServiceName set.
    console.warn(
      `[judgeAgentsHints] Agent${args.agentKey ? ` "${args.agentKey}"` : ''} (connectorProtocol="${args.connectorProtocol}") has no traceServiceName configured, and this protocol's service.name isn't fixed/known to agent-health — skipping Strategy C (service.name + time-window) trace correlation rather than guessing a name that would never match. Set traceServiceName in the agent config to the exact OTel resource service.name the agent's own OTel SDK emits, or trace-mode judging (useTraces:true) will rely on Strategy A/B/D only and may time out if those aren't available either.`
    );
    return undefined;
  }
  if (args.connectorProtocol) return `${args.connectorProtocol}-agent`;
  if (args.agentKey) return `${args.agentKey}-agent`;
  return undefined;
}

/**
 * Build the `agents: [{...}]` array to forward as `JudgeRequest.agents`.
 *
 * `endedAt` defaults to the report's persisted timestamp; `startedAt`
 * defaults to that minus `performanceMetrics.durationMs` (with slack), or
 * a 30-minute lookback when duration is missing. The trace tool sends
 * these through to `/api/traces` which intersects them with
 * `service.name = serviceName`.
 *
 * Returns an empty array when we can't derive a meaningful service name —
 * the caller can still pass that and the route just falls back to
 * Strategy B (runIds-only) without breaking.
 */
export function buildJudgeAgentsHints(
  report: Pick<TestCaseRun, 'agentKey' | 'connectorProtocol' | 'timestamp' | 'performanceMetrics' | 'sessionId'>,
  agentTraceServiceName?: string
): JudgeAgentsHint[] {
  const serviceName = resolveAgentServiceName({
    agentTraceServiceName,
    connectorProtocol: report.connectorProtocol,
    agentKey: report.agentKey,
  });
  if (!serviceName) return [];

  const ts = Date.parse(report.timestamp || '') || Date.now();
  const durationMs = report.performanceMetrics?.durationMs ?? 0;
  const span = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  // `report.timestamp` is NOT reliably the run END: trace-mode / subprocess
  // reports (e.g. Claude Code) are persisted at run START, so anchoring the
  // window's `endedAt` on the timestamp and looking only backwards lands the
  // entire window BEFORE the run and misses every span. Anchor SYMMETRICALLY
  // around the timestamp by ±(duration + slack) so the window covers the run
  // whether the timestamp marks its start or its end (empty-by-default is the
  // worse failure mode — see trace-correlation notes). Mirrors the deep-dive's
  // resolveWindow.
  return [{
    serviceName,
    startedAt: ts - span,
    endedAt: ts + span,
    ...(report.sessionId ? { sessionId: report.sessionId } : {}),
  }];
}

/**
 * Resolve the id forwarded as `runId` to `/api/judge` (provider `agent`).
 *
 * The route hard-requires a truthy `runId` ("runId is required for the agent
 * (trace) judge provider — its trace tools scope to it") because that's the
 * ONLY thing the trace tools historically scoped on (Strategy B). But REST
 * connectors never populate `report.runId` (`RESTConnector.execute()` returns
 * `data.runId || data.id || null`, and agent response bodies here carry
 * neither) — so any REST-connector agent using the `agent-trace-judge` model
 * 400s before the judge ever runs, EVEN when Strategy C (`agents` hints,
 * service.name + time-window) already has enough to find the real spans
 * (root-caused via a live smoke test 2026-09-01:
 * `example-rest-agent-variant` found its spans on poll attempt
 * 1 once `traceServiceName` was set, then still 400'd on this exact gate).
 *
 * Fallback is `report.traceId` ONLY (the eval's own OTel `test_case` span) —
 * deliberately NOT `report.id` (the storage doc id), and NOT `undefined`.
 * Two different downstream consumers read this value with different safety
 * properties:
 *   - `/api/traces` (`query_spans`): `traceJudgeTools.ts` sends it as
 *     `runIds:[runId]`, UNIONED (bool.should) with the `agents` Strategy-C
 *     hints, matched against `attributes.agent_health.run.id` /
 *     `attributes.gen_ai.conversation.id`. A value that matches no span is a
 *     harmless no-op contribution to that union — safe for ANY truthy
 *     string, including `report.id`.
 *   - `/api/logs` (`query_logs`): `fetchLogs()` (server/services/logsService.ts)
 *     treats a present `runId` as the ONLY filter — `match: { message: runId
 *     }` with NO time-range bound at all ("searching by runId, we want to
 *     find logs regardless of age"). `match` is analyzed: a hyphenated id
 *     like a `report.id` (e.g. `run-1788232186357-pxdnz1a4k`) tokenizes into
 *     `run` / `1788232186357` / `pxdnz1a4k` and would OR-match any log
 *     containing the extremely common word "run" anywhere in the cluster,
 *     unbounded by time — exactly the noise risk this codebase's Strategy-C
 *     docs warn about, but worse (no window). A 32-hex-char OTel `traceId`
 *     has no word boundaries for the analyzer to split on, so it behaves as
 *     one high-entropy token — realistically only ever matches a log line
 *     that legitimately contains this exact trace id.
 *
 * So `report.id` is NOT an acceptable fallback despite being always present:
 * it is safe for `/api/traces` but unsafe for `/api/logs`. When `traceId` is
 * ALSO absent (e.g. eval telemetry disabled), returning `undefined` and
 * letting the route's original 400 stand is the correct fail-closed
 * behavior — not a silent degrade into unscoped log search.
 *
 * The route's defense-in-depth check (`trajectoryRunIds.has(runId)`) only
 * activates when trajectory steps carry a `.runId` field (SDK-derived
 * trajectories); classic REST/subprocess trajectory steps never do, so this
 * fallback can't trip that 403 either way.
 */
export function resolveJudgeRunId(
  report: Pick<TestCaseRun, 'runId' | 'traceId'>
): string | undefined {
  return report.runId || report.traceId || undefined;
}

/**
 * Does this `/api/judge` (provider `agent`) request carry ANY correlation
 * handle its trace-query tools can scope to?
 *
 * True when EITHER:
 *   - `runId` is truthy — Strategy B. By the time a well-behaved caller
 *     reaches the route this is often already {@link resolveJudgeRunId}'s
 *     `traceId` fallback rather than a native run id; the two are
 *     indistinguishable (and equally valid) from here on, so this check
 *     doesn't need to know which one it is.
 *   - at least one entry in `agents` (Strategy C/D hints from
 *     {@link buildJudgeAgentsHints}) carries a `serviceName` or `sessionId`.
 *
 * This is the fix for the bug `resolveJudgeRunId` alone didn't cover: the
 * two SYNCHRONOUS (non-`useTraces`) judge call sites in
 * `services/evaluation/index.ts` (`runEvaluationWithConnector`'s "STANDARD
 * MODE" branch, used by every REST-connector agent that picks the
 * `agent-trace-judge` model WITHOUT enabling trace-mode polling) already
 * forward `agents` hints (`buildJudgeAgentsHints(...)`) — they just never
 * had a `runId` to forward, because the connector never minted one and
 * `report.traceId` isn't stamped yet at that point in the flow (that
 * stamping happens later, in `evaluationRunner.ts`, only on the trace-mode
 * branch). Pre-fix, `POST /api/judge`'s `if (!runId) return 400` rejected
 * these requests unconditionally, even though the hints it had received in
 * the SAME request body were already sufficient for the trace tools to
 * find real spans — the hints mechanism existed (#264) but the gate fired
 * first and never looked at it.
 *
 * Used by the route's `agent` provider gate (replacing the old
 * `if (!runId)` check) and by {@link createTraceJudgeExtension}
 * (`server/services/traceJudgeTools.ts`) to decide whether its tools are
 * enabled at all — the gate and the tools must agree, or the route accepts
 * a request whose tools then silently disable themselves and the judge
 * degrades to trajectory-only reasoning without anyone being told.
 */
export function hasTraceCorrelation(
  runId: string | undefined,
  agents?: Array<Pick<JudgeAgentsHint, 'serviceName' | 'sessionId'>>
): boolean {
  if (runId) return true;
  return Array.isArray(agents) && agents.some((a) => !!a && (!!a.serviceName || !!a.sessionId));
}
