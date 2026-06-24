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
 *   2. Protocol-default from the table above.
 *   3. `<connectorProtocol>-agent` heuristic (last-resort fallback).
 *   4. `<agentKey>-agent` as a final guess when protocol is unknown.
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
