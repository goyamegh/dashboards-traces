/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the storage list-endpoint pagination bug (API KPI
 * probe finding):
 *
 *   1. GET /api/storage/runs ignored `limit`/`from` entirely (only `size`/
 *      `from` were wired up) — `?limit=0`, `?limit=-5`, `?limit=100000` all
 *      silently fell back to the hardcoded default and returned an
 *      identical, unbounded-feeling dump.
 *   2. GET /api/storage/test-cases?limit=abc (or any non-numeric/invalid
 *      size) silently fell through to "no pagination" and returned every
 *      test case with full versioned content.
 *
 * These tests boot against a REAL running backend (see AH_PORT below) and
 * assert the actual HTTP behavior end-to-end — the regression signal that
 * matters is DIFFERENTIAL: a small `limit` must return fewer real items
 * than a large one, proving `limit` is actually wired up (before the fix,
 * every value produced the identical response).
 *
 * Requires the backend server to be running:
 *   AH_PORT=4331 BENCHMARK_RUN_RECOVERY_DISABLED=1 EVALUATION_RUN_RECOVERY_DISABLED=1 npm run dev:server
 *
 * Run:
 *   AH_PORT=4331 npm run test:integration -- --testPathPattern=listPagination
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    // 'connected' → OpenSearch backend; 'ok' → file backend. This route-level
    // fix applies to both.
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

describe('Storage list endpoints — pagination (limit/size/from validation)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping list-pagination integration tests');
      console.warn(`Start it with: AH_PORT=4331 npm run dev:server (checked ${BASE_URL})`);
    }
  }, 30000);

  describe('GET /api/storage/runs', () => {
    const marker = `pagination-probe-runs-${Date.now()}`;
    const createdRunIds: string[] = [];
    const RUN_COUNT = 5;

    beforeAll(async () => {
      if (!backendAvailable) return;
      for (let i = 0; i < RUN_COUNT; i++) {
        const res = await fetch(`${BASE_URL}/api/storage/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCaseId: marker,
            agentId: 'pagination-probe-agent',
            modelId: 'pagination-probe-model',
            iteration: i + 1,
            status: 'completed',
            passFailStatus: 'passed',
          }),
        });
        if (!res.ok) throw new Error(`Failed to create probe run: ${res.status}`);
        const run = await res.json();
        createdRunIds.push(run.id);
      }
    }, 30000);

    afterAll(async () => {
      if (!backendAvailable) return;
      for (const id of createdRunIds) {
        await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      }
    }, 30000);

    const countMarked = (runs: any[]) => runs.filter((r) => r.testCaseId === marker).length;

    it('respects `limit` (not just `size`) — a small limit returns fewer items than a large one', async () => {
      if (!backendAvailable) return;

      const small = await fetch(`${BASE_URL}/api/storage/runs?limit=2`).then((r) => r.json());
      const large = await fetch(`${BASE_URL}/api/storage/runs?limit=1000`).then((r) => r.json());

      const smallCount = countMarked(small.runs);
      const largeCount = countMarked(large.runs);

      // Before the fix, `limit` was never read (only `size`/`from` were), so
      // both requests silently used the hardcoded default and were
      // byte-for-byte identical regardless of the value sent.
      expect(smallCount).toBeLessThanOrEqual(2);
      expect(largeCount).toBe(RUN_COUNT);
      expect(smallCount).toBeLessThan(largeCount);
      expect(small.size).toBe(2);
      expect(large.size).toBe(1000);
    });

    it.each(['0', '-5', 'abc'])('clamps limit=%s to the default page size (100) rather than ignoring it', async (raw) => {
      if (!backendAvailable) return;

      const res = await fetch(`${BASE_URL}/api/storage/runs?limit=${raw}`).then((r) => r.json());
      expect(res.size).toBe(100);
      // All 5 probe runs fit comfortably under the default — still bounded,
      // just not truncated at this scale.
      expect(countMarked(res.runs)).toBe(RUN_COUNT);
    });

    it('supports `from`/`offset` for paging through results', async () => {
      if (!backendAvailable) return;

      const page1 = await fetch(`${BASE_URL}/api/storage/runs?limit=${RUN_COUNT}&from=0`).then((r) => r.json());
      const page2 = await fetch(`${BASE_URL}/api/storage/runs?limit=${RUN_COUNT}&offset=${RUN_COUNT}`).then((r) => r.json());

      expect(countMarked(page1.runs)).toBe(RUN_COUNT);
      // Paging past all real data should not include any of our marked runs again.
      expect(countMarked(page2.runs)).toBe(0);
    });
  });

  describe('GET /api/storage/test-cases', () => {
    const marker = `pagination-probe-tc-${Date.now()}`;
    const createdTestCaseIds: string[] = [];
    const TC_COUNT = 5;

    beforeAll(async () => {
      if (!backendAvailable) return;
      for (let i = 0; i < TC_COUNT; i++) {
        const id = `${marker}-${i}`;
        const res = await fetch(`${BASE_URL}/api/storage/test-cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            name: `${marker} ${i}`,
            category: 'RCA',
            difficulty: 'Medium',
            initialPrompt: `probe prompt ${i}`,
            context: [],
            expectedOutcomes: [],
          }),
        });
        if (!res.ok) throw new Error(`Failed to create probe test case: ${res.status}`);
        const tc = await res.json();
        createdTestCaseIds.push(tc.id);
      }
    }, 30000);

    afterAll(async () => {
      if (!backendAvailable) return;
      for (const id of createdTestCaseIds) {
        await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      }
    }, 30000);

    const countMarked = (testCases: any[]) => testCases.filter((tc) => typeof tc.name === 'string' && tc.name.startsWith(marker)).length;

    it('omitting size/limit entirely still returns everything (backward compat for existing UI callers)', async () => {
      if (!backendAvailable) return;

      const res = await fetch(`${BASE_URL}/api/storage/test-cases`).then((r) => r.json());
      expect(countMarked(res.testCases)).toBe(TC_COUNT);
      // Unpaginated mode never includes pagination metadata.
      expect(res.hasMore).toBeUndefined();
    });

    it('an invalid `size`/`limit` OPTS INTO pagination (with a clamped default) instead of silently returning everything', async () => {
      if (!backendAvailable) return;

      const res = await fetch(`${BASE_URL}/api/storage/test-cases?limit=abc`).then((r) => r.json());
      // The regression signal: presence of the param — even with garbage —
      // must engage paginated mode (hasMore defined), which is exactly what
      // was broken (it silently degraded to the unpaginated "everything" path).
      expect(res.hasMore).toBeDefined();
      expect(countMarked(res.testCases)).toBe(TC_COUNT); // still all 5 (5 < default 100)
    });

    it('a small `limit` returns fewer test cases than a large one', async () => {
      if (!backendAvailable) return;

      const small = await fetch(`${BASE_URL}/api/storage/test-cases?limit=2`).then((r) => r.json());
      const large = await fetch(`${BASE_URL}/api/storage/test-cases?limit=1000`).then((r) => r.json());

      expect(countMarked(small.testCases)).toBeLessThanOrEqual(2);
      expect(countMarked(large.testCases)).toBe(TC_COUNT);
      expect(countMarked(small.testCases)).toBeLessThan(countMarked(large.testCases));
      expect(small.hasMore).toBe(true);
    });
  });
});
