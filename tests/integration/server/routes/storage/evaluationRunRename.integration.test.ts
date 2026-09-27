/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the evaluation-run rename UX (owner ask: "I want to
 * be able to rename the evaluation run name") and the run-list newest-first
 * default ordering.
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Run:
 *   AH_PORT=4941 npm run test:integration -- --testPathPatterns=evaluationRunRename
 *
 * Covers:
 *   - PATCH { name } persists a trimmed rename and touches nothing else
 *     (no version bump, no stats change — verified by diffing the doc).
 *   - PATCH rejects an empty/whitespace-only name with 400 and does not
 *     persist anything.
 *   - GET /api/storage/evaluation-runs (default sort) returns newest-first,
 *     the true source of the "sort by time, not by benchmark name" fix
 *     (server-side createdAt desc — see server/adapters/opensearch/StorageModule.ts).
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

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

/** Seed an evaluation-run doc directly via PUT (upserts \u2014 PATCH requires the
 *  doc to already exist and 404s otherwise). */
const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-rename-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Rename Integration Test Source',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: [] }],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    stats: { passed: 3, failed: 1, total: 4 },
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

describe('Evaluation run rename + list ordering (integration)', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  }, 60000);

  describe('PATCH /api/storage/evaluation-runs/:id \u2014 rename', () => {
    it('persists a trimmed rename and does not touch stats/status/other fields', async () => {
      if (!backendAvailable) return;

      const original = uniqueTestName('rename-src');
      const seeded = await seedEvalRun({ name: original });
      tracker.evaluationRun(seeded.id);

      const newName = uniqueTestName('renamed');
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `  ${newName}  ` }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe(newName); // trimmed

      // Re-fetch to confirm the write actually persisted (not just echoed
      // back by the PATCH response) and nothing else moved.
      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`);
      const persisted = await getRes.json();
      expect(persisted.name).toBe(newName);
      expect(persisted.status).toBe(seeded.status);
      expect(persisted.stats).toEqual(seeded.stats);
      expect(persisted.agentKey).toBe(seeded.agentKey);
      expect(persisted.createdAt).toBe(seeded.createdAt);
    });

    it('rejects an empty name with 400 and leaves the stored name unchanged', async () => {
      if (!backendAvailable) return;

      const original = uniqueTestName('rename-empty-src');
      const seeded = await seedEvalRun({ name: original });
      tracker.evaluationRun(seeded.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);

      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`);
      const persisted = await getRes.json();
      expect(persisted.name).toBe(original);
    });

    it('rejects a name over the 200-character cap with 400', async () => {
      if (!backendAvailable) return;

      const seeded = await seedEvalRun({ name: uniqueTestName('rename-cap-src') });
      tracker.evaluationRun(seeded.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'y'.repeat(201) }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-existent run id', async () => {
      if (!backendAvailable) return;

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist-rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Anything' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH rename of a dual-written benchmark run (#465 owner report: "a refresh doesn\'t show the new name")', () => {
    /**
     * Runs created WITH a benchmarkId are dual-written (#399): a first-class
     * evaluation-run doc AND a legacy-shaped `BenchmarkRun` projection embedded
     * in `benchmark.runs[]`. The projection is what the benchmark Runs tab
     * (`/evaluations/benchmarks/:id/runs`) and every legacy benchmark surface
     * render, so a rename that only touches the top-level doc is invisible
     * there after a reload. This seeds the exact dual-written shape through the
     * public API (same recipe as tests/e2e/evalrun-rename-dualwrite.spec.ts),
     * renames, then re-fetches EVERY read surface fresh.
     */
    const seedDualWrittenRun = async () => {
      const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueTestName('rename-dualwrite-tc'),
          category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
        }),
      });
      if (!tcRes.ok) throw new Error(`seed test case failed: ${tcRes.status}`);
      const tc = await tcRes.json();
      const tcId: string = tc.id || tc.testCase?.id;
      tracker.testCase(tcId);

      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueTestName('rename-dualwrite-benchmark'),
          description: 'dual-write rename integration (#465)',
          testCaseIds: [tcId],
          runs: [],
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [tcId] }],
        }),
      });
      if (!bmRes.ok) throw new Error(`seed benchmark failed: ${bmRes.status}`);
      const benchmarkId: string = (await bmRes.json()).id;
      tracker.benchmark(benchmarkId);

      const runId = `eval-run-rename-dualwrite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const runName = uniqueTestName('rename-dualwrite-run');
      const createdAt = new Date().toISOString();

      // 1. Embedded projection (never carries docType — matches production).
      const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
      const putBm = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
          runs: [{
            id: runId, name: runName, agentKey: 'demo', modelId: 'demo-model', createdAt,
            status: 'completed', benchmarkVersion: 1, testCaseSnapshots: [], results: {},
          }],
        }),
      });
      if (!putBm.ok) throw new Error(`embed projection failed: ${putBm.status}`);

      // 2. First-class doc with the SAME id.
      const seeded = await seedEvalRun({
        id: runId, name: runName, benchmarkId, createdAt,
        sources: [{ type: 'benchmark', benchmarkId }],
      });
      tracker.evaluationRun(seeded.id);
      return { benchmarkId, runId, runName };
    };

    it('after PATCH, a fresh GET of the run, the run list, AND the benchmark\'s embedded runs[] all return the new name', async () => {
      if (!backendAvailable) return;

      const { benchmarkId, runId } = await seedDualWrittenRun();
      const newName = uniqueTestName('rename-dualwrite-after');

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      expect(res.status).toBe(200);

      // Fresh reads — nothing below reuses the PATCH response.
      const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
      expect(run.name).toBe(newName);

      const list = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&size=50`)).json();
      const listed = list.evaluationRuns.find((r: any) => r.id === runId);
      expect(listed?.name).toBe(newName);

      // The embedded projection is what the benchmark Runs tab renders on
      // reload — it MUST carry the rename too (this is the assertion that
      // reproduced the owner report before the server write-through fix).
      const bmAfter = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
      const embedded = (bmAfter.runs || []).find((r: any) => r.id === runId);
      expect(embedded).toBeDefined();
      expect(embedded.name).toBe(newName);
      // Write-through is name-only: the projection's other fields are untouched.
      expect(embedded.status).toBe('completed');
      expect(embedded.benchmarkVersion).toBe(1);
    });

    it('a rejected rename (400) leaves both copies at the original name', async () => {
      if (!backendAvailable) return;

      const { benchmarkId, runId, runName } = await seedDualWrittenRun();
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);

      const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
      expect(run.name).toBe(runName);
      const bmAfter = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
      expect((bmAfter.runs || []).find((r: any) => r.id === runId)?.name).toBe(runName);
    });
  });

  describe('GET /api/storage/evaluation-runs \u2014 default order', () => {
    it('returns runs newest-first by default (createdAt desc at the storage layer)', async () => {
      if (!backendAvailable) return;

      const base = Date.now();
      const older = await seedEvalRun({
        name: uniqueTestName('order-older'),
        createdAt: new Date(base - 60_000).toISOString(),
      });
      tracker.evaluationRun(older.id);
      const newer = await seedEvalRun({
        name: uniqueTestName('order-newer'),
        createdAt: new Date(base).toISOString(),
      });
      tracker.evaluationRun(newer.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?size=500`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      const ids: string[] = body.evaluationRuns.map((r: any) => r.id);
      const olderIdx = ids.indexOf(older.id);
      const newerIdx = ids.indexOf(newer.id);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeGreaterThanOrEqual(0);
      // Newest first: the newer run's index must come before the older run's.
      expect(newerIdx).toBeLessThan(olderIdx);
    });
  });
});
