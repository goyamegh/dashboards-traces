/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/storage/evaluation-runs/:id/rerun
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Run:
 *   AH_PORT=4681 npm run test:integration -- --testPathPatterns=evaluationRuns.rerun
 *
 * Covers:
 *   - 404 when the source run doesn't exist
 *   - Happy path: config duplication (agent/judge/evaluator/concurrency/sources),
 *     fresh id, "(re-run)" name suffix, rerunOf provenance link
 *   - Name suffix increments ("(re-run)" -> "(re-run 2)")
 *   - 409 when the source run's referenced benchmark no longer exists
 *   - 409 when the source run's pinned benchmark version no longer exists
 *   - Re-running a still-running source run is allowed (independent duplicate)
 *   - Legacy run missing `sources` (but with testCaseSnapshots) re-runs via a
 *     best-effort derived source, reported in defaultsApplied
 *   - Legacy run missing agentKey -> 400
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    // Both storage backends report `status: 'ok'` when healthy (file storage:
    // server/adapters/file/StorageModule.ts; OpenSearch:
    // server/adapters/opensearch/StorageModule.ts) — neither ever returns
    // `'connected'`, so checking for that string (a stale convention copied
    // across several sibling integration-test files) would always be false
    // and silently skip every guarded assertion below, in every environment.
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
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.statusText}`);
  const testCase = await response.json();
  return testCase.id;
};

const createBenchmark = async (name: string, testCaseIds: string[]): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      testCaseIds,
      runs: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create benchmark: ${response.statusText}`);
  return response.json();
};

/** Seed an evaluation-run doc directly (PUT upserts — PATCH requires the doc
 *  to already exist and 404s otherwise, verified against the running server). */
const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-rerun-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Rerun Integration Test Source',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
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

const cleanupIds: { testCases: string[]; evalRuns: string[]; benchmarks: string[] } = {
  testCases: [], evalRuns: [], benchmarks: [],
};

async function cancelAndTrack(runId: string) {
  cleanupIds.evalRuns.push(runId);
  await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' }).catch(() => {});
}

async function cleanup() {
  for (const id of cleanupIds.evalRuns) {
    await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.benchmarks) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.testCases) {
    await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

describe('POST /api/storage/evaluation-runs/:id/rerun', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await cleanup();
  });

  it('returns 404 when the source run does not exist', async () => {
    if (!backendAvailable) return;
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist/rerun`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('duplicates config onto a fresh, independent run and links rerunOf', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun Happy Path TC1');
    const tc2 = await createTestCase('Rerun Happy Path TC2');
    cleanupIds.testCases.push(tc1, tc2);

    const source = await seedEvalRun({
      name: 'Nightly Regression Suite',
      agentKey: 'demo',
      modelId: 'claude-sonnet',
      judgeModelId: 'claude-sonnet-4.6',
      evaluatorId: 'rca-default',
      concurrency: 2,
      sources: [{ type: 'test-case-ids', ids: [tc1, tc2] }],
      testCaseSnapshots: [
        { id: tc1, version: 1, name: 'Rerun Happy Path TC1' },
        { id: tc2, version: 1, name: 'Rerun Happy Path TC2' },
      ],
      status: 'completed',
    });
    cleanupIds.evalRuns.push(source.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.runId).toBeTruthy();
    expect(body.runId).not.toBe(source.id);
    expect(body.run.rerunOf).toBe(source.id);
    expect(body.run.name).toBe('Nightly Regression Suite (re-run)');
    expect(body.run.agentKey).toBe('demo');
    expect(body.run.judgeModelId).toBe('claude-sonnet-4.6');
    expect(body.run.evaluatorId).toBe('rca-default');
    expect(body.run.concurrency).toBe(2);
    expect(body.run.status).toBe('running');
    expect(Array.isArray(body.defaultsApplied)).toBe(true);
    expect(body.defaultsApplied).toEqual([]); // fully-populated source -> no defaults needed

    await cancelAndTrack(body.runId);

    // Verify it's actually persisted with the provenance link, independently
    // fetched (not just trusting the POST response echo).
    const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${body.runId}`);
    const persisted = await getRes.json();
    expect(persisted.rerunOf).toBe(source.id);
    expect(persisted.testCaseSnapshots.map((s: any) => s.id).sort()).toEqual([tc1, tc2].sort());
  }, 30000);

  it('increments an existing "(re-run)" suffix instead of doubling it', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun Suffix TC1');
    cleanupIds.testCases.push(tc1);

    const source = await seedEvalRun({
      name: 'Baseline (re-run)',
      sources: [{ type: 'test-case-ids', ids: [tc1] }],
      testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Suffix TC1' }],
    });
    cleanupIds.evalRuns.push(source.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run.name).toBe('Baseline (re-run 2)');

    await cancelAndTrack(body.runId);
  }, 30000);

  it('allows re-running a still-running source run (independent duplicate)', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun Still-Running TC1');
    cleanupIds.testCases.push(tc1);

    const source = await seedEvalRun({
      name: 'In-Flight Run',
      status: 'running',
      sources: [{ type: 'test-case-ids', ids: [tc1] }],
      testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Still-Running TC1' }],
    });
    cleanupIds.evalRuns.push(source.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run.rerunOf).toBe(source.id);

    await cancelAndTrack(body.runId);
  }, 30000);

  it('returns 409 when the source run\'s benchmark no longer exists', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun 409 TC1');
    cleanupIds.testCases.push(tc1);
    const bm = await createBenchmark(`Rerun 409 BM ${Date.now()}`, [tc1]);

    const source = await seedEvalRun({
      name: 'Benchmark-backed run',
      sources: [{ type: 'benchmark', benchmarkId: bm.id }],
      benchmarkId: bm.id,
      testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun 409 TC1' }],
    });
    cleanupIds.evalRuns.push(source.id);

    // Delete the benchmark out from under the run.
    await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}`, { method: 'DELETE' });

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(new RegExp(bm.id));
    expect(body.error).toMatch(/no longer exists/i);
  }, 30000);

  it('returns 409 when the source run\'s pinned benchmark version no longer exists', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun 409 Version TC1');
    cleanupIds.testCases.push(tc1);
    const bm = await createBenchmark(`Rerun 409 Version BM ${Date.now()}`, [tc1]);
    cleanupIds.benchmarks.push(bm.id);

    const source = await seedEvalRun({
      name: 'Pinned-version run',
      sources: [{ type: 'benchmark', benchmarkId: bm.id, benchmarkVersion: 99 }],
      testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun 409 Version TC1' }],
    });
    cleanupIds.evalRuns.push(source.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/version 99/i);
    expect(body.error).toMatch(/no longer exists/i);
  }, 30000);

  it('re-runs a legacy run missing `sources` by deriving from testCaseSnapshots, and reports the default', async () => {
    if (!backendAvailable) return;

    const tc1 = await createTestCase('Rerun Legacy TC1');
    cleanupIds.testCases.push(tc1);

    const source = await seedEvalRun({
      name: 'Legacy run with no sources',
      sources: [],
      testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Legacy TC1' }],
    });
    cleanupIds.evalRuns.push(source.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run.sources).toEqual([{ type: 'test-case-ids', ids: [tc1] }]);
    expect(body.defaultsApplied.some((n: string) => n.toLowerCase().includes('sources'))).toBe(true);

    await cancelAndTrack(body.runId);
  }, 30000);

  it('returns 400 when the source run is missing agentKey (nothing to re-run against)', async () => {
    if (!backendAvailable) return;

    // PATCH-upsert with agentKey omitted entirely (JSON.stringify drops
    // `undefined` keys), simulating a malformed/legacy doc.
    const id = `eval-run-rerun-test-noagent-${Date.now()}`;
    const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No agent run',
        status: 'completed',
        modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [] }],
        trigger: 'api',
        testCaseSnapshots: [],
        results: {},
        createdAt: new Date().toISOString(),
      }),
    });
    expect(response.ok).toBe(true);
    cleanupIds.evalRuns.push(id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}/rerun`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agentKey/i);
  }, 30000);
});
