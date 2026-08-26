/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the benchmark-runs-page union fix (dogfooding a
 * cost-aware eval, see lib/matchers/traces.ts CHANGELOG entry):
 *
 *   - `POST /api/storage/evaluation-runs` with a `benchmarkId` now links the
 *     resolved test case ids into that benchmark's `testCaseIds` at run
 *     creation time (services/benchmarkPromotion.ts:linkTestCaseIdsToBenchmark),
 *     so a benchmark created as a shell (`testCaseIds: []`, e.g. by
 *     `agent-health benchmark -f foo.eval.js -n "New Benchmark"`) is no
 *     longer permanently empty.
 *   - `GET /api/storage/evaluation-runs?benchmarkId=<id>` (already existing)
 *     is the data source `BenchmarkRunsPage.tsx` unions with
 *     `benchmark.runs[]` so CLI/run-first runs render on the benchmark page.
 *
 * Requires a running backend (AH_PORT / AGENT_HEALTH_PORT, default 4001) —
 * boot with BENCHMARK_RUN_RECOVERY_DISABLED=1 EVALUATION_RUN_RECOVERY_DISABLED=1
 * per repo convention. Uses `agentKey: 'demo'` (mock provider, deterministic,
 * no external creds needed) so the run completes fast.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok' || data.status === 'connected';
  } catch {
    return false;
  }
};

const cleanupIds: { testCases: string[]; evalRuns: string[]; benchmarks: string[]; reports: string[] } = {
  testCases: [],
  evalRuns: [],
  benchmarks: [],
  reports: [],
};

async function cleanup() {
  for (const id of cleanupIds.reports) {
    try { await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  for (const id of cleanupIds.evalRuns) {
    try { await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  for (const id of cleanupIds.benchmarks) {
    try { await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  for (const id of cleanupIds.testCases) {
    try { await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
}

async function createTestCase(name: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: `Test prompt for ${name}`,
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test', '@traces-cost-attrs'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.status} ${await response.text()}`);
  const tc = await response.json();
  cleanupIds.testCases.push(tc.id);
  return tc.id;
}

async function createShellBenchmark(name: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'traces-cost-attrs integration test shell', testCaseIds: [] }),
  });
  if (!response.ok) throw new Error(`Failed to create benchmark: ${response.status} ${await response.text()}`);
  const bm = await response.json();
  cleanupIds.benchmarks.push(bm.id);
  return bm.id;
}

/** POST an evaluation run and drain its SSE stream to completion. */
async function runEvaluationToCompletion(body: Record<string, unknown>): Promise<{ runId: string | null; sawCompleted: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let runId: string | null = null;
  let sawCompleted = false;

  try {
    const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to start run: ${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          if (data.runId) runId = data.runId;
          if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
            sawCompleted = true;
          }
        } catch { /* skip malformed */ }
      }
      if (sawCompleted) break;
    }
  } finally {
    clearTimeout(timeout);
  }

  if (runId) {
    cleanupIds.evalRuns.push(runId);
    try {
      const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
      for (const result of Object.values((run.results || {}) as Record<string, any>)) {
        if (result?.reportId) cleanupIds.reports.push(result.reportId);
      }
    } catch { /* best-effort cleanup bookkeeping */ }
  }

  return { runId, sawCompleted };
}

describe('Evaluation run -> benchmark testCaseIds linking (run-first shell repair)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await cleanup();
  });

  it('links resolved test case ids into a benchmarkId-scoped run into the benchmark\'s testCaseIds, bumping the version', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Link Test Case');
    const benchmarkId = await createShellBenchmark('Shell Benchmark For Link Test');

    // Sanity: starts as a genuine shell.
    const before = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(before.testCaseIds).toEqual([]);
    expect(before.currentVersion).toBe(1);

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    expect(runId).toBeTruthy();
    if (runId) cleanupIds.evalRuns.push(runId);

    const after = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(after.testCaseIds).toContain(testCaseId);
    expect(after.currentVersion).toBeGreaterThan(before.currentVersion);
  });

  it('is discoverable via GET /api/storage/evaluation-runs?benchmarkId=<id> (the data source BenchmarkRunsPage unions)', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Discoverability Test Case');
    const benchmarkId = await createShellBenchmark('Shell Benchmark For Discoverability Test');

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    expect(runId).toBeTruthy();
    if (runId) cleanupIds.evalRuns.push(runId);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.evaluationRuns.some((r: any) => r.id === runId)).toBe(true);

    // And the benchmark itself picked up the link (belt-and-suspenders with
    // the previous test, using a different benchmark/run pair).
    const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(bm.testCaseIds).toContain(testCaseId);
  });

  it('is a no-op (no version bump) when the benchmark already has every referenced id', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Already Linked Test Case');
    const benchmarkId = await createShellBenchmark('Pre-linked Benchmark');

    // Pre-link the id via the normal update path (version -> 2).
    await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [testCaseId] }),
    });
    const afterPrelink = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(afterPrelink.currentVersion).toBe(2);

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    if (runId) cleanupIds.evalRuns.push(runId);

    const after = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(after.currentVersion).toBe(2); // unchanged — no spurious version bump
    expect(after.testCaseIds).toEqual([testCaseId]);
  });
});
