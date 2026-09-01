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
  // (e.g. ai-search-redkite-qwen-mtrl-stark-retail) never populate
  // report.runId (RESTConnector.execute() returns `data.runId || data.id ||
  // null`, and the agent's own response body carries neither), so the
  // agent-trace-judge's hard `if (!runId) return 400` gate at
  // server/routes/judge.ts always rejected these reports even once trace
  // correlation (Strategy C) found the real spans. resolveJudgeRunId falls
  // back to report.traceId ONLY — NOT report.id, which is unsafe: /api/logs
  // treats a truthy runId as an unbounded `match: { message: runId }` query,
  // and a hyphenated report id like `run-<ts>-<rand>` tokenizes into common
  // words ("run") that would pull in unrelated cluster logs. See the
  // function doc comment for the full safety analysis (codex_review finding,
  // 2026-09-01).

  it('prefers the real connector runId (Strategy B) when present', () => {
    expect(resolveJudgeRunId({ runId: 'run-abc', traceId: 'trace-xyz' })).toBe('run-abc');
  });

  it('falls back to the eval traceId (Strategy A) when runId is absent', () => {
    expect(resolveJudgeRunId({ runId: undefined, traceId: 'trace-xyz' })).toBe('trace-xyz');
  });

  it('does NOT fall back to a fabricated value when neither runId nor traceId is set — fails closed', () => {
    // report.id is deliberately NOT a fallback (see doc comment): unlike
    // /api/traces (safe no-op union), /api/logs would run an unbounded,
    // analyzed text match on it, risking unrelated-log noise on a shared
    // cluster. Returning undefined here preserves the route's original
    // fail-closed 400 instead of silently degrading to unscoped log search.
    expect(resolveJudgeRunId({ runId: undefined, traceId: undefined })).toBeUndefined();
  });

  it('treats empty-string runId/traceId as absent, not as a valid value', () => {
    expect(resolveJudgeRunId({ runId: '', traceId: '' })).toBeUndefined();
  });
});
