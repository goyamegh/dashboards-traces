/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/storage/evaluation-runs/:id/retry-judgement
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Run:
 *   AH_PORT=4881 npm run test:integration -- --testPathPatterns=retryJudgement
 *
 * Uses `judgeModelId: 'demo-model'` throughout so the judge call routes to
 * the built-in demo/mock provider (server/routes/judge.ts) instead of real
 * Bedrock — a deterministic, credential-free stand-in for "a MOCK judge".
 * The demo judge's accuracy floor (0.7) always resolves to 'passed' for a
 * non-empty trajectory, which is what these assertions rely on.
 *
 * Covers:
 *   - 404 when the run doesn't exist
 *   - 409 when the run is still 'running'
 *   - happy path: only the judge-failed (metricsStatus:'error') case is
 *     retried; the already-passed case is left untouched; report + run.stats
 *     are updated
 *   - a case with metricsStatus:'error' but no stored trajectory (agent
 *     crash) is NOT retried — nothing to salvage
 *   - scope=all re-judges every rejudgeable case, including already-passed
 *     ones
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
};

const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: `Test prompt for ${name}`,
      expectedOutcomes: ['the agent identifies the root cause'],
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.statusText}`);
  const testCase = await response.json();
  return testCase.id;
};

/** Seed a report doc directly with a specific id. */
const createReport = async (id: string, overrides: Record<string, any> = {}): Promise<any> => {
  const now = new Date().toISOString();
  const body = {
    id,
    timestamp: now,
    agentName: 'Demo Agent',
    agentKey: 'demo',
    modelName: 'demo-model',
    modelId: 'demo-model',
    testCaseId: overrides.testCaseId,
    status: 'completed',
    trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    llmJudgeReasoning: '',
    ...overrides,
  };
  const response = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Failed to seed report: ${response.status} ${await response.text()}`);
  return response.json();
};

/** Seed an evaluation-run doc directly (PUT upserts). */
const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-retry-judge-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Retry Judgement Integration Test',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'demo-model',
    judgeModelId: 'demo-model',
    sources: [{ type: 'test-case-ids', ids: [] }],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    createdAt: new Date().toISOString(),
    ...overrides,
    id,
  };
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(`Failed to seed eval run: ${response.status} ${await response.text()}`);
  return response.json();
};

const cleanupIds: { testCases: string[]; evalRuns: string[]; reports: string[] } = {
  testCases: [], evalRuns: [], reports: [],
};

async function cleanup() {
  for (const id of cleanupIds.evalRuns) {
    await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.reports) {
    await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.testCases) {
    await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

describe('POST /api/storage/evaluation-runs/:id/retry-judgement', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await cleanup();
  });

  it('returns 404 when the run does not exist', async () => {
    if (!backendAvailable) return;
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist/retry-judgement`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the run is still running', async () => {
    if (!backendAvailable) return;
    const run = await seedEvalRun({ status: 'running' });
    cleanupIds.evalRuns.push(run.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/still executing/i);
  }, 15000);

  it('returns 409 when a second retry-judgement request arrives while the first is still in flight (codex_review: same-process double-submit guard)', async () => {
    if (!backendAvailable) return;

    const tc = await createTestCase('Retry Judgement — concurrent submit');
    cleanupIds.testCases.push(tc);

    const report = await createReport(`report-retry-concurrent-${Date.now()}`, {
      testCaseId: tc,
      metricsStatus: 'error',
      passFailStatus: null,
    });
    cleanupIds.reports.push(report.id);

    const run = await seedEvalRun({
      testCaseSnapshots: [{ id: tc, version: 1, name: 'Retry Judgement — concurrent submit' }],
      results: { [tc]: { reportId: report.id, status: 'completed' } },
    });
    cleanupIds.evalRuns.push(run.id);

    // Fire two requests back-to-back without awaiting the first — the
    // in-process guard should reject the second with 409 rather than let
    // both race the same report/run docs.
    const [res1, res2] = await Promise.all([
      fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' }),
      fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' }),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loserBody = await (res1.status === 409 ? res1 : res2).json();
    expect(loserBody.error).toMatch(/already in progress/i);
  }, 30000);

  it('retries only the judge-failed case, leaves the passed case untouched, and recomputes stats', async () => {
    if (!backendAvailable) return;

    const tcErrored = await createTestCase('Retry Judgement — errored case');
    const tcPassed = await createTestCase('Retry Judgement — already passed');
    cleanupIds.testCases.push(tcErrored, tcPassed);

    const reportErrored = await createReport(`report-retry-errored-${Date.now()}`, {
      testCaseId: tcErrored,
      metricsStatus: 'error',
      passFailStatus: null,
      traceError: 'Judge evaluation failed (kind=judge_failed): mock 400',
      llmJudgeReasoning: '**Evaluator could not run.**',
    });
    const reportPassed = await createReport(`report-retry-passed-${Date.now()}`, {
      testCaseId: tcPassed,
      metricsStatus: 'ready',
      passFailStatus: 'passed',
      llmJudgeReasoning: 'Looks good.',
    });
    cleanupIds.reports.push(reportErrored.id, reportPassed.id);

    const run = await seedEvalRun({
      testCaseSnapshots: [
        { id: tcErrored, version: 1, name: 'Retry Judgement — errored case' },
        { id: tcPassed, version: 1, name: 'Retry Judgement — already passed' },
      ],
      results: {
        [tcErrored]: { reportId: reportErrored.id, status: 'completed' },
        [tcPassed]: { reportId: reportPassed.id, status: 'completed', passFailStatus: 'passed' },
      },
    });
    cleanupIds.evalRuns.push(run.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.retried).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].testCaseId).toBe(tcErrored);
    expect(body.results[0].outcome).toBe('succeeded');
    expect(body.results[0].passFailStatus).toBe('passed'); // demo judge floor (0.7 accuracy) always passes

    // Report doc actually persisted the verdict — independently re-fetched.
    const reportRes = await fetch(`${BASE_URL}/api/storage/runs/${reportErrored.id}`);
    const persistedReport = await reportRes.json();
    expect(persistedReport.metricsStatus).toBe('completed');
    expect(persistedReport.passFailStatus).toBe('passed');
    expect(persistedReport.matcherResults?.length).toBeGreaterThan(0);

    // Run doc: results + recomputed stats.
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`);
    const persistedRun = await runRes.json();
    expect(persistedRun.results[tcErrored].passFailStatus).toBe('passed');
    expect(persistedRun.results[tcPassed].passFailStatus).toBe('passed'); // untouched
    expect(persistedRun.stats).toMatchObject({ passed: 2, failed: 0, errored: 0, total: 2 });
  }, 30000);

  it('does not retry a judge-failed case with no stored trajectory (agent crash — nothing to salvage)', async () => {
    if (!backendAvailable) return;

    const tcCrash = await createTestCase('Retry Judgement — agent crash');
    cleanupIds.testCases.push(tcCrash);

    const reportCrash = await createReport(`report-retry-crash-${Date.now()}`, {
      testCaseId: tcCrash,
      metricsStatus: 'error',
      passFailStatus: null,
      trajectory: [],
      traceError: 'Agent run did not complete (kind=agent_failed): subprocess timeout',
    });
    cleanupIds.reports.push(reportCrash.id);

    const run = await seedEvalRun({
      testCaseSnapshots: [{ id: tcCrash, version: 1, name: 'Retry Judgement — agent crash' }],
      results: { [tcCrash]: { reportId: reportCrash.id, status: 'completed' } },
    });
    cleanupIds.evalRuns.push(run.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retried).toBe(0);
    expect(body.results).toEqual([]);

    // Report is left exactly as it was — no judge call attempted.
    const reportRes = await fetch(`${BASE_URL}/api/storage/runs/${reportCrash.id}`);
    const persistedReport = await reportRes.json();
    expect(persistedReport.metricsStatus).toBe('error');
  }, 30000);

  it('scope=all re-judges every rejudgeable case, including an already-passed one', async () => {
    if (!backendAvailable) return;

    const tcPassed = await createTestCase('Retry Judgement — scope=all');
    cleanupIds.testCases.push(tcPassed);

    const reportPassed = await createReport(`report-retry-scopeall-${Date.now()}`, {
      testCaseId: tcPassed,
      metricsStatus: 'ready',
      passFailStatus: 'passed',
    });
    cleanupIds.reports.push(reportPassed.id);

    const run = await seedEvalRun({
      testCaseSnapshots: [{ id: tcPassed, version: 1, name: 'Retry Judgement — scope=all' }],
      results: { [tcPassed]: { reportId: reportPassed.id, status: 'completed', passFailStatus: 'passed' } },
    });
    cleanupIds.evalRuns.push(run.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement?scope=all`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retried).toBe(1);
    expect(body.results[0].testCaseId).toBe(tcPassed);
  }, 30000);
});
