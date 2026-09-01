/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildJudgeAgentsHints, resolveAgentServiceName, resolveJudgeRunId } from '@/services/traces/judgeAgentsHints';
import type { TestCaseRun } from '@/types';

const baseReport = (over: Partial<TestCaseRun> = {}): Pick<
  TestCaseRun,
  'agentKey' | 'connectorProtocol' | 'timestamp' | 'performanceMetrics' | 'sessionId'
> => ({
  agentKey: 'cc',
  connectorProtocol: 'claude-code',
  timestamp: '2026-06-23T22:00:00.000Z',
  performanceMetrics: { durationMs: 120_000 } as any,
  ...over,
});

describe('buildJudgeAgentsHints', () => {
  it('resolves the protocol-default service name', () => {
    expect(resolveAgentServiceName({ connectorProtocol: 'claude-code' })).toBe('claude-code-agent');
  });

  it('returns a window hint with serviceName + bounded window', () => {
    const [hint] = buildJudgeAgentsHints(baseReport());
    expect(hint.serviceName).toBe('claude-code-agent');
    expect(hint.endedAt).toBeGreaterThan(hint.startedAt);
    // No sessionId on the report → hint omits it (Strategy C only).
    expect(hint.sessionId).toBeUndefined();
  });

  it('anchors the window SYMMETRICALLY around the timestamp (subprocess timestamp = run start)', () => {
    const ts = Date.parse('2026-06-23T22:00:00.000Z');
    const durationMs = 120_000;
    const [hint] = buildJudgeAgentsHints(baseReport({ performanceMetrics: { durationMs } as any }));
    // span = duration + 60s slack, applied to BOTH sides so the window covers
    // [ts, ts+duration] even when ts marks the run start.
    const span = durationMs + 60_000;
    expect(hint.startedAt).toBe(ts - span);
    expect(hint.endedAt).toBe(ts + span);
  });

  it('threads report.sessionId onto the hint for Strategy D (#313)', () => {
    const [hint] = buildJudgeAgentsHints(baseReport({ sessionId: 'sess-xyz' }));
    expect(hint.sessionId).toBe('sess-xyz');
  });

  it('returns [] when no service name can be derived', () => {
    expect(
      buildJudgeAgentsHints({ timestamp: '', performanceMetrics: undefined } as any)
    ).toEqual([]);
  });
});

describe('resolveJudgeRunId', () => {
  // Root cause (2026-09-01 trace_timeout smoke test): REST-connector agents
  // (e.g. example-rest-agent-variant) never populate
  // report.runId (RESTConnector.execute() returns `data.runId || data.id ||
  // null`, and the agent's own response body carries neither), so the
  // agent-trace-judge's hard `if (!runId) return 400` gate at
  // server/routes/judge.ts always rejected these reports even once trace
  // correlation (Strategy C) found the real spans. resolveJudgeRunId's
  // fallback chain keeps that gate satisfiable without ever sending a
  // fabricated value that could defeat the route's trajectory cross-check.

  it('prefers the real connector runId (Strategy B) when present', () => {
    expect(resolveJudgeRunId({ runId: 'run-abc', traceId: 'trace-xyz', id: 'report-1' })).toBe('run-abc');
  });

  it('falls back to the eval traceId (Strategy A) when runId is absent', () => {
    expect(resolveJudgeRunId({ runId: undefined, traceId: 'trace-xyz', id: 'report-1' })).toBe('trace-xyz');
  });

  it('falls back to the report id when neither runId nor traceId is set (REST connectors)', () => {
    expect(resolveJudgeRunId({ runId: undefined, traceId: undefined, id: 'report-1' })).toBe('report-1');
  });

  it('treats empty-string runId/traceId as absent, not as a valid value', () => {
    expect(resolveJudgeRunId({ runId: '', traceId: '', id: 'report-1' })).toBe('report-1');
  });

  it('returns undefined only when the report itself has no id (should not happen for a persisted report)', () => {
    expect(resolveJudgeRunId({ runId: undefined, traceId: undefined, id: undefined as any })).toBeUndefined();
  });
});
