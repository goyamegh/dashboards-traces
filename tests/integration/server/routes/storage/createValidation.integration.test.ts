/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for create-route validation on storage endpoints.
 *
 * Regression coverage for a high-severity API KPI-probe finding: several
 * `POST /api/storage/*` create/bulk routes accepted empty (`{}`) or
 * garbage bodies and either persisted junk documents (201) or blew up
 * with a generic 500 deep in a storage adapter. Every route below must:
 *   - reject an empty/garbage body with 400 JSON (never 201, never 500)
 *   - never leave a persisted document behind for a rejected body
 *   - still accept and persist a valid body (201 / 200 as appropriate)
 *
 * These tests require the backend server to be running:
 *   AH_PORT=4332 npm run dev:server
 *
 * Run:
 *   AH_PORT=4332 npm run test:integration -- --testPathPattern=createValidation.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    if (!response.ok) return false;
    const data = await response.json();
    return data?.status === 'connected' || data?.status === 'ok';
  } catch {
    return false;
  }
};

// Unique marker so this suite's created data never collides with real data
// or other test runs sharing the cluster.
const NAME_MARKER = `createvalidation-integration-${Date.now()}-${process.pid}`;

// Track every id this suite creates, deleted by id only (never by name scan).
const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];
const createdRunIds: string[] = [];

const deleteTestCase = (id: string) =>
  fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
const deleteBenchmark = (id: string) =>
  fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
const deleteRun = (id: string) =>
  fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});

describe('Storage create-route validation (regression: empty/garbage body must 400, never 201/500)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping create-validation integration tests');
      console.warn(`Start it with: AH_PORT=4332 npm run dev:server (BASE_URL=${BASE_URL})`);
    }
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;
    // Children before parents.
    for (const id of createdRunIds) await deleteRun(id);
    for (const id of createdBenchmarkIds) await deleteBenchmark(id);
    for (const id of createdTestCaseIds) await deleteTestCase(id);
  }, 30000);

  // ── POST /api/storage/test-cases ────────────────────────────────────────
  describe('POST /api/storage/test-cases', () => {
    it('rejects an empty body with 400 JSON (regression: previously 500 from a generic Error)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
      expect(body.error.toLowerCase()).toContain('name');
    });

    it('does not persist anything for the rejected empty body', async () => {
      if (!backendAvailable) return;
      const before = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`).then((r) => r.json());
      await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const after = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`).then((r) => r.json());
      expect(after.total).toBe(before.total);
    }, 60000);

    it('rejects a body with a non-string name with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 123 }),
      });
      expect(response.status).toBe(400);
    });

    it('still accepts a valid body (201)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${NAME_MARKER}-tc-valid`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'valid create',
          context: [],
          expectedOutcomes: [],
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.id).toBeDefined();
      createdTestCaseIds.push(created.id);
    });
  });

  // ── POST /api/storage/test-cases/bulk ───────────────────────────────────
  describe('POST /api/storage/test-cases/bulk', () => {
    it('rejects a batch containing a nameless item with 400 (never persists, never 500)', async () => {
      if (!backendAvailable) return;
      const before = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`).then((r) => r.json());

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCases: [
            { name: `${NAME_MARKER}-bulk-valid` },
            {}, // garbage item
          ],
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(typeof body.error).toBe('string');

      const after = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`).then((r) => r.json());
      expect(after.total).toBe(before.total);
    }, 60000);

    it('rejects a non-array body with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('still bulk-creates a fully valid batch', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCases: [
            { name: `${NAME_MARKER}-bulk-1`, category: 'RCA', difficulty: 'Easy', context: [], expectedOutcomes: [] },
            { name: `${NAME_MARKER}-bulk-2`, category: 'RCA', difficulty: 'Easy', context: [], expectedOutcomes: [] },
          ],
        }),
      });
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.created).toBe(2);
      for (const tc of result.testCases ?? []) {
        if (tc.id) createdTestCaseIds.push(tc.id);
      }
    });
  });

  // ── POST /api/storage/benchmarks ────────────────────────────────────────
  describe('POST /api/storage/benchmarks', () => {
    it('rejects an empty body with 400 JSON (regression: previously 201 with a nameless benchmark)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
      expect(body.error.toLowerCase()).toContain('name');
    });

    it('does not persist anything for the rejected empty body', async () => {
      if (!backendAvailable) return;
      const before = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`).then((r) => r.json());
      await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const after = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`).then((r) => r.json());
      expect(after.total).toBe(before.total);
    });

    it('rejects testCaseIds that is not an array of strings with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-bad-ids`, testCaseIds: 'not-an-array' }),
      });
      expect(response.status).toBe(400);
    });

    it('still accepts a valid body (201)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-bm-valid`, testCaseIds: [] }),
      });
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.id).toBeDefined();
      expect(created.name).toBe(`${NAME_MARKER}-bm-valid`);
      createdBenchmarkIds.push(created.id);
    });
  });

  // ── POST /api/storage/benchmarks/bulk ───────────────────────────────────
  describe('POST /api/storage/benchmarks/bulk', () => {
    it('does not persist a nameless item from a mixed batch (regression: previously always persisted)', async () => {
      if (!backendAvailable) return;
      const before = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`).then((r) => r.json());

      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarks: [{}] }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.created).toBe(0);
      expect(body.errors).toBeGreaterThanOrEqual(1);

      const after = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`).then((r) => r.json());
      expect(after.total).toBe(before.total);
    });

    it('rejects a non-array body with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('still bulk-creates a valid item while rejecting a garbage sibling', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          benchmarks: [{ name: `${NAME_MARKER}-bulk-bm-valid`, testCaseIds: [] }, {}],
        }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.created).toBe(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);

      // Find and track it for cleanup.
      const list = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`).then((r) => r.json());
      const created = (list.benchmarks ?? []).find((b: any) => b.name === `${NAME_MARKER}-bulk-bm-valid`);
      expect(created).toBeDefined();
      if (created) createdBenchmarkIds.push(created.id);
    });
  });

  // ── POST /api/storage/runs ──────────────────────────────────────────────
  describe('POST /api/storage/runs', () => {
    it('rejects an empty body with 400 JSON (regression: previously 201 with an empty report doc)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
    });

    it('does not persist anything for a rejected body (verified via a searchable marker testCaseId)', async () => {
      if (!backendAvailable) return;
      // Give this invalid body a unique, searchable testCaseId so we can prove
      // via /runs/search that no report referencing it was ever written --
      // more reliable on a live shared cluster than comparing aggregate
      // /runs totals, which fluctuate with concurrent unrelated activity.
      const markerTestCaseId = `${NAME_MARKER}-runs-empty-body-marker`;
      const response = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: markerTestCaseId,
          // Missing agentName/modelName -- invalid.
        }),
      });
      expect(response.status).toBe(400);

      const search = await fetch(`${BASE_URL}/api/storage/runs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseId: markerTestCaseId }),
      }).then((r) => r.json());
      expect(search.runs ?? []).toEqual([]);
    });

    it('rejects an invalid status value with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: 'x',
          agentName: 'agent',
          modelName: 'model',
          status: 'not-a-real-status',
        }),
      });
      expect(response.status).toBe(400);
    });

    it('still accepts a valid body (201)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: `${NAME_MARKER}-tcid`,
          agentName: 'test-agent',
          modelName: 'test-model',
          status: 'completed',
          trajectory: [],
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.id).toBeDefined();
      expect(created.testCaseId).toBe(`${NAME_MARKER}-tcid`);
      createdRunIds.push(created.id);
    });
  });

  // ── POST /api/storage/runs/bulk ─────────────────────────────────────────
  describe('POST /api/storage/runs/bulk', () => {
    it('does not persist a garbage item from a batch (regression: previously always persisted)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs: [{}] }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.created).toBe(0);
      expect(body.errors).toBeGreaterThanOrEqual(1);
    });

    it('rejects a non-array body with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('still bulk-creates a valid item while rejecting a garbage sibling', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/runs/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [
            { testCaseId: `${NAME_MARKER}-bulk-run-tcid`, agentName: 'a', modelName: 'm', status: 'completed' },
            {},
          ],
        }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.created).toBe(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);

      const search = await fetch(`${BASE_URL}/api/storage/runs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseId: `${NAME_MARKER}-bulk-run-tcid` }),
      }).then((r) => r.json());
      const created = (search.runs ?? [])[0];
      expect(created).toBeDefined();
      if (created) createdRunIds.push(created.id);
    });
  });

  // ── POST /api/storage/evaluators (already-correct route, guards regression) ─
  describe('POST /api/storage/evaluators (baseline: already validates)', () => {
    it('rejects an empty body with 400 JSON', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/evaluators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });
  });

  // ── POST /api/storage/evaluation-runs (already-correct route) ──────────
  describe('POST /api/storage/evaluation-runs (baseline: already validates)', () => {
    it('rejects an empty body with 400 JSON', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });
  });
});
