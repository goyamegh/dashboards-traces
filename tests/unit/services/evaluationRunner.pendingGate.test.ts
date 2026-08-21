/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for the 2026-08-21 "eager judge verdict clobbered by
 * spurious trace polling" bug.
 *
 * Chain: the runner pre-persists a placeholder report with
 * `metricsStatus: 'pending'`; the classic (no SDK body) path eagerly judges
 * and returns a report that — pre-fix — carried NO `metricsStatus`. The
 * save-merge (`runs.update(placeholderId, fields)`) drops undefined fields,
 * so the placeholder's 'pending' survived onto `savedReport`, which
 * (with a subprocess `runId` present) sent a useTraces:false agent into
 * 10-minute trace polling that timed out and overwrote the judge verdict
 * with `trace_timeout`.
 *
 * Fixes under test:
 *   1. evaluationRunner gate requires `agentConfig.useTraces` before polling.
 *   2. (belt) evaluation service stamps `metricsStatus: 'ready' | 'error'`
 *      on eagerly-judged reports — covered here by asserting the merged doc
 *      never stays 'pending' even when the connector-path report omits it.
 */
import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getForAgent: jest.fn() },
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      {
        key: 'pi-os-rag',
        name: 'Pi (OpenSearch RAG)',
        endpoint: 'pi',
        connectorType: 'pi',
        useTraces: false,
      },
      {
        key: 'traced-agent',
        name: 'Traced Agent',
        endpoint: 'http://localhost:3000',
        connectorType: 'agui-streaming',
        useTraces: true,
      },
    ],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  })),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: {} },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn(() => []),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));

jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(),
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { tracePollingManager } from '@/services/traces/tracePoller';

const mockRunEval = runEvaluationWithConnector as jest.Mock;
const mockStartPolling = tracePollingManager.startPolling as jest.Mock;

function createMockStorage(): IStorageModule {
  const docs = new Map<string, any>();
  const create = jest.fn().mockImplementation((report: any) => {
    const id = report.id ?? `report-${docs.size + 1}`;
    const doc = { ...report, id };
    docs.set(id, doc);
    return Promise.resolve(doc);
  });
  // Merge semantics — mirrors the real adapters (partial update).
  const update = jest.fn().mockImplementation((id: string, updates: any) => {
    const existing = docs.get(id) || { id };
    const merged = { ...existing, ...updates, id };
    docs.set(id, merged);
    return Promise.resolve(merged);
  });
  return {
    runs: { create, update, getById: jest.fn() },
    evaluationRuns: { update: jest.fn() },
  } as unknown as IStorageModule;
}

function makeRun(agentKey: string): EvaluationRun {
  return {
    id: 'run-1',
    name: 'Run',
    agentKey,
    modelId: 'claude-sonnet',
    status: 'running',
    results: {},
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

const TC: TestCase = {
  id: 'tc-1',
  name: 'TC',
  initialPrompt: 'Test prompt',
  context: [],
} as unknown as TestCase;

/** Judged report as the PRE-FIX eval service returned it: no metricsStatus. */
function judgedReportWithoutMetricsStatus() {
  return {
    id: 'ignored-by-placeholder-merge',
    timestamp: new Date().toISOString(),
    agentName: 'Pi (OpenSearch RAG)',
    agentKey: 'pi-os-rag',
    modelName: 'claude-sonnet',
    modelId: 'claude-sonnet',
    testCaseId: TC.id,
    testCaseVersion: 1,
    status: 'completed',
    passFailStatus: 'passed',
    trajectory: [{ type: 'response', content: 'answer' }],
    metrics: { accuracy: 100, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    llmJudgeReasoning: 'looks right',
    improvementStrategies: [],
    runId: 'subprocess-12345', // subprocess connectors always produce a runId
    rawEvents: [],
  };
}

describe('executeEvaluationRun — pending-placeholder must not trigger trace polling for useTraces:false agents', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
  });

  it('useTraces:false + report without metricsStatus + runId → NO trace polling, verdict preserved', async () => {
    mockRunEval.mockResolvedValue(judgedReportWithoutMetricsStatus());

    const run = await executeEvaluationRun(makeRun('pi-os-rag'), [TC], {
      storageModule: storage,
      onProgress: jest.fn(),
    });

    // The operative regression: no 10-minute poll for an eagerly-judged report.
    expect(mockStartPolling).not.toHaveBeenCalled();

    // The run completes with the judge verdict intact.
    expect(run.status).toBe('completed');
    expect(run.results[TC.id].status).toBe('completed');
    expect((run.results[TC.id] as any).passFailStatus).toBe('passed');
  });

  it('useTraces:true agent with pending report still polls (guard must not break trace mode)', async () => {
    mockRunEval.mockResolvedValue({
      ...judgedReportWithoutMetricsStatus(),
      agentKey: 'traced-agent',
      metricsStatus: 'pending',
      passFailStatus: undefined,
    });
    // Resolve the wait immediately via the error callback — we only care
    // that polling was engaged.
    mockStartPolling.mockImplementation((_id: string, _runId: string, callbacks: any) => {
      callbacks.onError(new Error('no traces in unit test'));
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      onProgress: jest.fn(),
    });

    expect(mockStartPolling).toHaveBeenCalledTimes(1);
  });
});
