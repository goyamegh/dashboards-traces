/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildJudgeAgentsHints, resolveAgentServiceName, resolveJudgeRunId, hasTraceCorrelation } from '@/services/traces/judgeAgentsHints';
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

  describe('connectorProtocol=rest with no traceServiceName (2026-09-01 trace_timeout root cause)', () => {
    // example-rest-agent-variant: connectorType 'rest', no
    // traceServiceName configured. Before this fix, resolveAgentServiceName
    // silently guessed "rest-agent" (a service.name that never existed),
    // so Strategy C confidently polled the wrong name for the full attempt
    // budget (60/60) while the agent's REAL spans (service.name
    // "example-agent") sat on the cluster the whole time. Silent wrong-name
    // polling is worse than no Strategy C at all — it must now warn loudly
    // and skip, not guess.
    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('does NOT fabricate "rest-agent" — returns undefined instead', () => {
      expect(resolveAgentServiceName({ connectorProtocol: 'rest' })).toBeUndefined();
    });

    it('logs a loud, always-on warning naming the agent and protocol', () => {
      resolveAgentServiceName({ connectorProtocol: 'rest', agentKey: 'example-rest-agent' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg] = warnSpy.mock.calls[0];
      expect(msg).toContain('example-rest-agent');
      expect(msg).toContain('rest');
      expect(msg).toContain('traceServiceName');
    });

    it('buildJudgeAgentsHints returns [] for a rest agent with no traceServiceName (Strategy C correctly skipped)', () => {
      expect(
        buildJudgeAgentsHints(baseReport({ connectorProtocol: 'rest', agentKey: 'example-rest-agent' }))
      ).toEqual([]);
    });

    it('an explicit traceServiceName override still wins — no warning, no skip', () => {
      expect(
        resolveAgentServiceName({ connectorProtocol: 'rest', agentTraceServiceName: 'example-agent' })
      ).toBe('example-agent');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('applies the same treatment to the other generic-transport protocols (openai-compatible, langgraph, strands, mock)', () => {
      for (const protocol of ['openai-compatible', 'langgraph', 'strands', 'mock'] as const) {
        expect(resolveAgentServiceName({ connectorProtocol: protocol })).toBeUndefined();
      }
      expect(warnSpy).toHaveBeenCalledTimes(4);
    });

    it('known protocols we own (claude-code/kiro/pi/agui-streaming/subprocess) are unaffected — no warning', () => {
      expect(resolveAgentServiceName({ connectorProtocol: 'claude-code' })).toBe('claude-code-agent');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('preserves the last-resort <protocol>-agent guess for a genuinely unknown (not-in-union) connector protocol string', () => {
      // A user-configured custom connector key that isn't in the upstream
      // ConnectorProtocol union at all — distinct from the KNOWN-unknowable
      // protocols above, which is why this path is kept.
      expect(resolveAgentServiceName({ connectorProtocol: 'some-custom-connector' as any })).toBe(
        'some-custom-connector-agent'
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe('resolveJudgeRunId', () => {
  // Root cause (2026-09-01 trace_timeout smoke test): REST-connector agents
  // (e.g. example-rest-agent-variant) never populate
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

describe('hasTraceCorrelation (the /api/judge "agent" provider gate matrix)', () => {
  // Root cause (extending #461 / trace-poll-fix): the two SYNCHRONOUS
  // (non-useTraces) judge call sites in services/evaluation/index.ts forward
  // `agents` Strategy-C hints but never have a runId (REST connectors never
  // mint one, and report.traceId isn't stamped yet at that point in the
  // flow) -- so server/routes/judge.ts's old unconditional `if (!runId)`
  // 400'd every one of these requests even though the hints it already had
  // were sufficient. This matrix pins the 4 cases the gate must decide.

  it('runId present, no hints -- allowed (Strategy B alone)', () => {
    expect(hasTraceCorrelation('run-abc', undefined)).toBe(true);
    expect(hasTraceCorrelation('run-abc', [])).toBe(true);
  });

  it('runId present AND already resolved from traceId (resolveJudgeRunId fallback) -- allowed', () => {
    const runId = resolveJudgeRunId({ runId: undefined, traceId: 'trace-xyz' });
    expect(hasTraceCorrelation(runId, undefined)).toBe(true);
  });

  it('no runId, hints-only with serviceName+window -- allowed (the reported bug)', () => {
    const agents = [{ serviceName: 'example-agent', startedAt: 1, endedAt: 2 }];
    expect(hasTraceCorrelation(undefined, agents)).toBe(true);
  });

  it('no runId, hints-only with sessionId but no serviceName -- allowed', () => {
    const agents = [{ serviceName: '', startedAt: 1, endedAt: 2, sessionId: 'sess-1' }];
    expect(hasTraceCorrelation(undefined, agents)).toBe(true);
  });

  it('no runId, no hints at all -- rejected (nothing to scope to)', () => {
    expect(hasTraceCorrelation(undefined, undefined)).toBe(false);
    expect(hasTraceCorrelation(undefined, [])).toBe(false);
  });

  it('no runId, hints present but every entry carries neither serviceName nor sessionId -- rejected', () => {
    const agents = [{ serviceName: '', startedAt: 1, endedAt: 2 }];
    expect(hasTraceCorrelation(undefined, agents as any)).toBe(false);
  });

  it('empty-string runId is treated as absent, same as resolveJudgeRunId', () => {
    expect(hasTraceCorrelation('', undefined)).toBe(false);
    expect(hasTraceCorrelation('', [{ serviceName: 'svc', startedAt: 1, endedAt: 2 }])).toBe(true);
  });
});
