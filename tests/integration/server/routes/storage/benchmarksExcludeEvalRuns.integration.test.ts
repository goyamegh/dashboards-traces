/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the Benchmarks API must NOT surface evaluation-runs.
 *
 * Benchmarks and evaluation-runs share one storage index/dir, discriminated by
 * `docType`. The benchmark list (`getAll`) and detail (`getById`) ops must
 * exclude `docType: 'evaluation-run'` docs — otherwise CLI/SDK eval-runs leak
 * into the Benchmarks page as empty "0 TCs / 0 runs" rows, and the benchmark
 * detail route renders an eval-run id as an empty benchmark.
 *
 * Regression for the two bugs reported on /evaluations/benchmarks:
 *   1. list: 53 eval-run rows shown with 0/0 stats
 *   2. detail: /evaluations/benchmarks/<eval-run-id>/runs renders an empty benchmark
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it creates.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    const d = await r.json();
    return d.status === 'connected';
  } catch {
    return false;
  }
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const evalRunId = `eval-run-bmleak-${suffix}`;
let benchmarkId = '';
let backendUp = false;

beforeAll(async () => {
  backendUp = await checkBackend();
  if (!backendUp) return;

  // 1. Seed an evaluation-run (docType 'evaluation-run') via upsert PATCH.
  const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${evalRunId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: evalRunId,
      name: `BM-leak eval-run ${suffix}`,
      status: 'completed',
      agentKey: 'demo',
      modelId: 'claude-sonnet',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
      createdAt: new Date().toISOString(),
    }),
  });
  if (!runRes.ok) throw new Error(`seed eval-run failed: ${runRes.status} ${await runRes.text()}`);

  // 2. Create a real benchmark (docType benchmark / none).
  const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `BM-leak real benchmark ${suffix}`, testCaseIds: [] }),
  });
  if (!bmRes.ok) throw new Error(`create benchmark failed: ${bmRes.status} ${await bmRes.text()}`);
  benchmarkId = (await bmRes.json()).id;
});

afterAll(async () => {
  if (!backendUp) return;
  await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(evalRunId)}`, { method: 'DELETE' }).catch(() => {});
  if (benchmarkId) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`, { method: 'DELETE' }).catch(() => {});
  }
});

describe('Benchmarks API excludes evaluation-runs', () => {
  it('GET /api/storage/benchmarks does not include any evaluation-run docs (BUG 1)', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks`);
    expect(res.ok).toBe(true);
    const { benchmarks } = await res.json();
    const ids = benchmarks.map((b: any) => b.id);
    // the real benchmark is present…
    expect(ids).toContain(benchmarkId);
    // …but the eval-run is NOT, and nothing returned carries the eval-run docType
    expect(ids).not.toContain(evalRunId);
    expect(benchmarks.some((b: any) => b.docType === 'evaluation-run')).toBe(false);
  });

  it('GET /api/storage/benchmarks/:id returns 404 for an evaluation-run id (BUG 2)', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(evalRunId)}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/storage/benchmarks/:id still returns a real benchmark', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const bm = body.benchmark ?? body;
    expect(bm.id).toBe(benchmarkId);
  });
});
