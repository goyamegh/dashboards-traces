/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runEvaluationWithConnector` must carry the connector's session audit
 * (`metadata.agentSession` → `report.agentSession`) onto EVERY report shape
 * it can return — judged, skip-judge, trace-mode pending, AND judge-failed.
 * The judge-failed path is the one most easily forgotten (adversarial review
 * finding): it is exactly the run where "the judge failed AND the agent was
 * denied Bash" is a real diagnosis, so dropping the audit there is a bug.
 */
import { runEvaluationWithConnector } from '@/services/evaluation';
import { callBedrockJudge } from '@/services/evaluation/bedrockJudge';
import type { AgentConfig, TestCase } from '@/types';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(),
  simulateBedrockJudge: jest.fn(),
}));

const agentSession = {
  agentVersion: '2.1.201',
  skills: ['opensearch-dsl'],
  skillsInvoked: ['opensearch-dsl'],
  toolsUsed: ['Skill', 'Read'],
  permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'ls' } }],
  numTurns: 3,
};

const connector = {
  type: 'claude-code',
  name: 'fake',
  buildPayload: () => 'prompt',
  execute: jest.fn(async () => ({
    trajectory: [{ id: 's1', timestamp: 1, type: 'response', content: 'done' }],
    runId: 'run-1',
    rawEvents: [],
    metadata: { sessionId: 'sess-1', agentSession },
  })),
};
const registry = { getForAgent: () => connector } as any;

const testCase = {
  id: 'tc-1',
  name: 'tc',
  initialPrompt: 'do it',
  context: [],
  expectedOutcomes: ['done'],
  labels: [],
  currentVersion: 1,
} as unknown as TestCase;

const baseAgent = { key: 'a', name: 'Agent', endpoint: 'claude', connectorType: 'claude-code' } as unknown as AgentConfig;

describe('runEvaluationWithConnector carries agentSession onto every report shape', () => {
  beforeEach(() => {
    (callBedrockJudge as jest.Mock).mockReset();
  });

  it('judged path', async () => {
    (callBedrockJudge as jest.Mock).mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100 },
      llmJudgeReasoning: 'ok',
      improvementStrategies: [],
      judgeDurationMs: 1,
    });
    const report = await runEvaluationWithConnector(baseAgent, 'm', testCase, jest.fn(), { registry });
    expect(report.status).toBe('completed');
    expect(report.sessionId).toBe('sess-1');
    expect(report.agentSession).toEqual(agentSession);
  });

  it('skip-judge path', async () => {
    const report = await runEvaluationWithConnector(baseAgent, 'm', testCase, jest.fn(), { registry, skipJudge: true });
    expect(callBedrockJudge).not.toHaveBeenCalled();
    expect(report.agentSession).toEqual(agentSession);
  });

  it('trace-mode pending path', async () => {
    const report = await runEvaluationWithConnector({ ...baseAgent, useTraces: true } as AgentConfig, 'm', testCase, jest.fn(), { registry });
    expect(report.metricsStatus).toBe('pending');
    expect(report.agentSession).toEqual(agentSession);
  });

  it('judge-FAILED path (evaluator error) keeps the audit — the agent did run', async () => {
    (callBedrockJudge as jest.Mock).mockRejectedValue(new Error('judge exploded'));
    const report = await runEvaluationWithConnector(baseAgent, 'm', testCase, jest.fn(), { registry });
    expect(report.status).toBe('completed');
    expect(report.metricsStatus).toBe('error');
    expect(report.sessionId).toBe('sess-1');
    expect(report.agentSession).toEqual(agentSession);
    expect(report.agentSession?.permissionDenials).toHaveLength(1);
  });

  it('a connector without session audit yields no agentSession (no empty object)', async () => {
    connector.execute.mockResolvedValueOnce({
      trajectory: [],
      runId: null,
      rawEvents: [],
      metadata: { exitCode: 0 },
    } as any);
    const report = await runEvaluationWithConnector(baseAgent, 'm', testCase, jest.fn(), { registry, skipJudge: true });
    expect(report.agentSession).toBeUndefined();
    expect('agentSession' in report && report.agentSession === undefined).toBe(true);
  });
});
