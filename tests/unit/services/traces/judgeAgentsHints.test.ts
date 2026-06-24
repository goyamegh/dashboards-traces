/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildJudgeAgentsHints, resolveAgentServiceName } from '@/services/traces/judgeAgentsHints';
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
