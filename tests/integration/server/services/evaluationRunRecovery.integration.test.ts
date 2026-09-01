/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for boot-time recovery of orphan top-level EvaluationRun
 * docs (server/services/evaluationRunRecoveryOnBoot.ts) — the sister of
 * benchmarkRunRecovery.integration.test.ts for the unified evaluation-run
 * model. Regression covered: without this module, a crashed
 * evaluation-run-based run stayed `running` forever on the Evaluations page,
 * and — after the ongoing-runs-visibility fix started linking a `running`
 * projection into `benchmark.runs` at start — could end up INCONSISTENT
 * with its own benchmark projection (legacy recovery marks the embedded
 * copy failed; the top-level doc the Evaluations page reads stays running
 * forever) unless this module keeps both in sync.
 *
 * These tests require the backend server to be running with test endpoints
 * enabled:
 *   AGENT_HEALTH_TEST_ENDPOINTS=1 AH_PORT=<port> node server/dist/index.js
 *
 * Run:
 *   AH_PORT=<port> npm run test:integration -- --testPathPatterns=evaluationRunRecovery
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const STALE_AGE_MS = 60 * 60 * 1000 + 1; // 1h + 1ms — past the 1h default

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function isBackendUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function isTestEndpointEnabled(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/admin/recover-orphan-evaluation-runs`, { method: 'POST' });
    return r.status !== 404;
  } catch {
    return false;
  }
}

async function createTestCase(name: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
    }),
  });
  if (!r.ok) throw new Error(`Failed to create test case: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

async function createBenchmark(name: string, testCaseIds: string[]): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, testCaseIds, runs: [], currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    }),
  });
  if (!r.ok) throw new Error(`Failed to create benchmark: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

/** Seed a stale, orphaned top-level EvaluationRun doc via the PUT upsert route. */
async function seedOrphanEvaluationRun(run: Record<string, any>): Promise<void> {
  const r = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  if (!r.ok) throw new Error(`Failed to seed evaluation run ${run.id}: ${r.status} ${await r.text()}`);
}

/** Link a projection into benchmark.runs the same way the create route's starting-link does (add-if-absent). */
async function seedBenchmarkProjection(benchmarkId: string, run: Record<string, any>): Promise<void> {
  const get = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
  if (!get.ok) throw new Error(`Failed to fetch benchmark ${benchmarkId}: ${get.status}`);
  const bm = await get.json();
  const put = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
      runs: [...(bm.runs || []), run],
    }),
  });
  if (!put.ok) throw new Error(`Failed to PUT benchmark ${benchmarkId}: ${put.status} ${await put.text()}`);
}

async function getEvaluationRun(id: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed GET evaluation run ${id}: ${r.status}`);
  return r.json();
}

async function getBenchmark(id: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed GET benchmark ${id}: ${r.status}`);
  return r.json();
}

async function triggerRecovery(): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/admin/recover-orphan-evaluation-runs`, { method: 'POST' });
  if (!r.ok) throw new Error(`Recovery endpoint failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];
const createdEvalRunIds: string[] = [];

describe('Evaluation run recovery on boot — integration', () => {
  jest.setTimeout(60_000);

  let backendUp = false;
  let endpointUp = false;

  beforeAll(async () => {
    backendUp = await isBackendUp();
    if (!backendUp) {
      console.warn('Backend not available — skipping. Start with: AH_PORT=<port> node server/dist/index.js');
      return;
    }
    endpointUp = await isTestEndpointEnabled();
    if (!endpointUp) {
      console.warn(
        'Test admin endpoints not enabled — skipping. Restart server with: ' +
        'AGENT_HEALTH_TEST_ENDPOINTS=1 node server/dist/index.js',
      );
    }
  });

  afterAll(async () => {
    for (const id of createdEvalRunIds) {
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdBenchmarkIds) {
      await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('marks a stale ad-hoc (no benchmarkId) running run as failed, including unstarted results', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('eval-recovery-adhoc-A-' + Date.now());
    const tcB = await createTestCase('eval-recovery-adhoc-B-' + Date.now());
    createdTestCaseIds.push(tcA, tcB);

    const runId = `eval-run-recovery-int-${Date.now()}-1`;
    createdEvalRunIds.push(runId);
    await seedOrphanEvaluationRun({
      id: runId,
      docType: 'evaluation-run',
      name: 'Orphan Ad-hoc Run',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {
        [tcA]: { reportId: '', status: 'pending' },
        [tcB]: { reportId: '', status: 'running' },
      },
    });

    const stat = await triggerRecovery();
    expect(stat.staleRuns).toBeGreaterThanOrEqual(1);
    expect(stat.runsMarkedFailed).toBeGreaterThanOrEqual(1);

    const run = await getEvaluationRun(runId);
    expect(run.status).toBe('failed');
    expect(run.results[tcA].status).toBe('failed');
    expect(run.results[tcA].error).toMatch(/boot recovery/);
    expect(run.results[tcB].status).toBe('failed');
  });

  it('syncs the benchmark.runs projection to failed too, keeping both views consistent', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('eval-recovery-linked-A-' + Date.now());
    createdTestCaseIds.push(tcA);
    const bmId = await createBenchmark('eval-recovery-linked-bm-' + Date.now(), [tcA]);
    createdBenchmarkIds.push(bmId);

    const runId = `eval-run-recovery-int-${Date.now()}-2`;
    createdEvalRunIds.push(runId);

    const startingProjection = {
      id: runId,
      name: 'Orphan Linked Run',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      agentKey: 'demo',
      modelId: 'demo-model',
      testCaseSnapshots: [],
      results: { [tcA]: { reportId: '', status: 'pending' } },
    };
    await seedBenchmarkProjection(bmId, startingProjection);
    await seedOrphanEvaluationRun({
      id: runId,
      docType: 'evaluation-run',
      name: 'Orphan Linked Run',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [],
      trigger: 'api',
      benchmarkId: bmId,
      testCaseSnapshots: [],
      results: { [tcA]: { reportId: '', status: 'pending' } },
    });

    const stat = await triggerRecovery();
    expect(stat.benchmarkProjectionsSynced).toBeGreaterThanOrEqual(1);

    const run = await getEvaluationRun(runId);
    expect(run.status).toBe('failed');

    const bm = await getBenchmark(bmId);
    const matches = (bm.runs || []).filter((r: any) => r.id === runId);
    expect(matches).toHaveLength(1); // never duplicated
    expect(matches[0].status).toBe('failed');
  });

  it('does not touch recent running runs', async () => {
    if (!backendUp || !endpointUp) return;

    const runId = `eval-run-recovery-int-${Date.now()}-3`;
    createdEvalRunIds.push(runId);
    await seedOrphanEvaluationRun({
      id: runId,
      docType: 'evaluation-run',
      name: 'Recent Run',
      createdAt: new Date().toISOString(),
      status: 'running',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
    });

    await triggerRecovery();

    const run = await getEvaluationRun(runId);
    expect(run.status).toBe('running'); // untouched
  });

  it('is idempotent — running recovery twice produces the same final state', async () => {
    if (!backendUp || !endpointUp) return;

    const runId = `eval-run-recovery-int-${Date.now()}-4`;
    createdEvalRunIds.push(runId);
    await seedOrphanEvaluationRun({
      id: runId,
      docType: 'evaluation-run',
      name: 'Idempotent Run',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [],
      trigger: 'api',
      testCaseSnapshots: [],
      results: { a: { reportId: '', status: 'pending' } },
    });

    await triggerRecovery();
    const first = JSON.stringify(await getEvaluationRun(runId));

    const stat2 = await triggerRecovery();
    const second = JSON.stringify(await getEvaluationRun(runId));

    expect(second).toEqual(first);
    expect(stat2.runsMarkedFailed).toBe(0); // no longer 'running' on the second pass
  });
});
