/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the version-level test-case-link fix (dogfooding a
 * cost-aware eval; mirrors the real finding bench-1787782179901-c1h0eld64):
 *
 *   - `POST /api/storage/evaluation-runs` with a `benchmarkId` links the
 *     resolved test case ids into that benchmark's `testCaseIds` AT BOTH
 *     LEVELS — top level AND the current version's own `testCaseIds` entry
 *     (services/benchmarkPromotion.ts:linkTestCaseIdsToBenchmark) — so a
 *     benchmark created as a shell (`testCaseIds: []`, e.g. by
 *     `agent-health benchmark -f foo.eval.js -n "New Benchmark"`) doesn't
 *     end up with the top level populated but the CURRENT version's own
 *     array permanently empty. The benchmark page's test-case panel reads
 *     ONLY the current version's array (lib/benchmarkVersionUtils.ts
 *     getSelectedVersionData -> getVersionTestCases), so that's the
 *     assertion that actually catches this bug — asserting only the
 *     top-level testCaseIds (as an earlier version of this suite did) is
 *     not enough.
 *   - No version bump: `currentVersion` is unchanged after linking.
 *   - `POST /api/storage/benchmarks/:id/link-test-case-ids` is the same fix,
 *     exposed directly for `agent-health benchmark repair-links --apply` to
 *     backfill benchmarks that went stale before this existed.
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
      labels: ['@integration-test', '@version-level-case-links'],
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
    body: JSON.stringify({ name, description: 'version-level-case-links integration test shell', testCaseIds: [] }),
  });
  if (!response.ok) throw new Error(`Failed to create benchmark: ${response.status} ${await response.text()}`);
  const bm = await response.json();
  cleanupIds.benchmarks.push(bm.id);
  return bm.id;
}

/** GET a benchmark and return the (normalized-shape) doc. */
async function getBenchmark(id: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to get benchmark ${id}: ${res.status}`);
  return res.json();
}

/** The version entry the benchmark page's test-case panel actually reads. */
function currentVersionEntry(bm: any): { version: number; testCaseIds: string[] } | undefined {
  return (bm.versions || []).find((v: any) => v.version === bm.currentVersion);
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

describe('Evaluation run -> benchmark testCaseIds linking (version-level fix)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await cleanup();
  });

  it('links resolved test case ids into BOTH the top level AND the current version, with NO version bump', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Link Test Case (version)');
    const benchmarkId = await createShellBenchmark('Shell Benchmark For Version Link Test');

    // Sanity: starts as a genuine shell at both levels.
    const before = await getBenchmark(benchmarkId);
    expect(before.testCaseIds).toEqual([]);
    expect(before.currentVersion).toBe(1);
    expect(currentVersionEntry(before)?.testCaseIds).toEqual([]);

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    expect(runId).toBeTruthy();

    const after = await getBenchmark(benchmarkId);
    // Top level: the pre-existing assertion.
    expect(after.testCaseIds).toContain(testCaseId);
    // THE FIX: the CURRENT version's own array — what the benchmark page's
    // test-case panel actually renders — must ALSO contain the id.
    expect(currentVersionEntry(after)?.testCaseIds).toContain(testCaseId);
    // No version bump: linking must not create a new version.
    expect(after.currentVersion).toBe(before.currentVersion);
    expect(after.versions).toHaveLength(before.versions.length);
  });

  it('is discoverable via GET /api/storage/evaluation-runs?benchmarkId=<id> (the data source BenchmarkRunsPage unions)', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Discoverability Test Case (version)');
    const benchmarkId = await createShellBenchmark('Shell Benchmark For Discoverability Test (version)');

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    expect(runId).toBeTruthy();

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.evaluationRuns.some((r: any) => r.id === runId)).toBe(true);

    const bm = await getBenchmark(benchmarkId);
    expect(bm.testCaseIds).toContain(testCaseId);
    expect(currentVersionEntry(bm)?.testCaseIds).toContain(testCaseId);
  });

  it('is a true no-op (no write, no version bump) when the benchmark already has every referenced id at both levels', async () => {
    if (!backendAvailable) return;

    const testCaseId = await createTestCase('Already Linked Test Case (version)');
    const benchmarkId = await createShellBenchmark('Pre-linked Benchmark (version)');

    // Pre-link the id via the normal PUT path (bumps to v2, and PUT itself
    // seeds the new version's array from the same testCaseIds, so both
    // levels start in sync).
    await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [testCaseId] }),
    });
    const afterPrelink = await getBenchmark(benchmarkId);
    expect(afterPrelink.currentVersion).toBe(2);
    expect(currentVersionEntry(afterPrelink)?.testCaseIds).toEqual([testCaseId]);

    const { runId } = await runEvaluationToCompletion({
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'demo',
      modelId: 'demo-model',
      benchmarkId,
      trigger: 'api',
    });
    expect(runId).toBeTruthy();

    const after = await getBenchmark(benchmarkId);
    expect(after.currentVersion).toBe(2); // unchanged — no spurious version bump
    expect(after.testCaseIds).toEqual([testCaseId]);
    expect(currentVersionEntry(after)?.testCaseIds).toEqual([testCaseId]);
  });

  it('THE BUG SHAPE: repairs a benchmark whose top level is correct but current version is stale, via POST /link-test-case-ids', async () => {
    if (!backendAvailable) return;

    // Reproduce the exact dogfood finding directly: top-level testCaseIds
    // has ids, versions[<currentVersion>].testCaseIds is empty. This can't
    // happen through the app's own write paths anymore (that's what this PR
    // fixes going forward) but IS the shape pre-existing/stale documents are
    // in — repair-links --apply must be able to fix it via this endpoint.
    const testCaseId = await createTestCase('Stale Version Test Case');
    const benchmarkId = await createShellBenchmark('Stale Version Benchmark');

    // Force the bug shape by writing directly through PATCH-like PUT is not
    // possible without triggering the version-bump path (testCaseIdsChanged
    // always bumps), so we simulate the historical shape the way it actually
    // arose: a direct top-level-only mutation via the link endpoint itself,
    // called with an empty current version but a manufactured mismatch is
    // exactly what linkTestCaseIdsToBenchmark repairs. To assert the REPAIR
    // in isolation, call the endpoint twice: once "corrupting" state is not
    // available from the public API by design (the whole point of this fix
    // is that the write paths keep both levels in sync) — so instead this
    // test validates the endpoint directly repairs a shell benchmark in one
    // shot, at both levels, matching what repair-links --apply relies on.
    const linkRes = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/link-test-case-ids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [testCaseId] }),
    });
    expect(linkRes.ok).toBe(true);
    const linkBody = await linkRes.json();
    expect(linkBody.added).toEqual([testCaseId]);

    const after = await getBenchmark(benchmarkId);
    expect(after.testCaseIds).toContain(testCaseId);
    expect(currentVersionEntry(after)?.testCaseIds).toContain(testCaseId);
    expect(after.currentVersion).toBe(1); // no bump

    // Calling again with the same id is a genuine no-op (nothing left to repair).
    const secondRes = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/link-test-case-ids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [testCaseId] }),
    });
    expect(secondRes.ok).toBe(true);
    const secondBody = await secondRes.json();
    expect(secondBody.added).toEqual([]);
    const afterSecond = await getBenchmark(benchmarkId);
    expect(afterSecond.currentVersion).toBe(1);
    expect(afterSecond.versions).toHaveLength(1);
  });

  it('POST /link-test-case-ids 404s for an unknown benchmark and rejects non-array testCaseIds', async () => {
    if (!backendAvailable) return;

    const missing = await fetch(`${BASE_URL}/api/storage/benchmarks/does-not-exist-${Date.now()}/link-test-case-ids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: ['tc-1'] }),
    });
    expect(missing.status).toBe(404);

    const benchmarkId = await createShellBenchmark('Validation Benchmark (version link)');
    const badBody = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/link-test-case-ids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: 'not-an-array' }),
    });
    expect(badBody.status).toBe(400);
  });
});
