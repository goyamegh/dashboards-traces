/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for async storage services
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=asyncStorage.integration
 */

import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import { createTestDataTracker, uniqueTestName } from '../../../helpers/testDataTracker';

// Skip tests if backend is not running
const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    // Both storage backends report `status: 'ok'` when healthy (file storage:
    // server/adapters/file/StorageModule.ts; OpenSearch:
    // server/adapters/opensearch/StorageModule.ts) — neither ever returns
    // 'connected'. Comparing against 'connected' (a stale convention copied
    // across several sibling integration-test files) was ALWAYS false, so
    // every guarded test below silently early-returned — the whole suite
    // green-lit without asserting anything, in every environment.
    return health.status === 'ok';
  } catch {
    return false;
  }
};

describe('OpenSearch Storage Integration Tests', () => {
  let backendAvailable = false;
  // Tracks every entity this suite creates so cleanup is ordered, 404-tolerant
  // and crash-ledgered — see tests/helpers/testDataTracker.ts.
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
    }
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  describe('storageAdmin', () => {
    it('should check health status', async () => {
      if (!backendAvailable) return;

      const health = await storageAdmin.health();
      // 'ok' is what GET /api/storage/health actually returns when healthy —
      // this used to assert 'connected', which no backend ever reports; the
      // assertion only "passed" because the broken guard above skipped it.
      expect(health.status).toBe('ok');
    });

    it('should get storage stats', async () => {
      if (!backendAvailable) return;

      const stats = await storageAdmin.stats();
      expect(stats.stats).toBeDefined();
      expect(stats.stats.evals_test_cases).toBeDefined();
      expect(stats.stats.evals_experiments).toBeDefined();
      expect(stats.stats.evals_runs).toBeDefined();
      expect(stats.stats.evals_analytics).toBeDefined();
    });
  });

  describe('asyncTestCaseStorage', () => {
    let createdTestCaseId: string | null = null;
    // Unique per run so parallel/aborted runs on the shared cluster never
    // collide. Cleanup is tracker-only (ids this run created) — never sweep
    // shared storage by name; "name looks test-ish" is not proof of ownership.
    const testCaseName = uniqueTestName('async-storage-tc');
    const updatedTestCaseName = uniqueTestName('async-storage-tc-updated');

    it('should create a test case', async () => {
      if (!backendAvailable) return;

      const testCase = await asyncTestCaseStorage.create({
        name: testCaseName,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Test prompt',
        context: [],
        expectedTrajectory: [],
      });

      expect(testCase).toBeDefined();
      expect(testCase.id).toBeDefined();
      expect(testCase.name).toBe(testCaseName);
      expect(testCase.currentVersion).toBe(1);

      // Store ID for cleanup and subsequent tests
      createdTestCaseId = testCase.id;
      tracker.testCase(testCase.id);
    });

    it('should get test case by ID', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const testCase = await asyncTestCaseStorage.getById(createdTestCaseId);
      expect(testCase).toBeDefined();
      expect(testCase?.id).toBe(createdTestCaseId);
    });

    it('should get all test cases', async () => {
      if (!backendAvailable) return;

      const testCases = await asyncTestCaseStorage.getAll();
      expect(Array.isArray(testCases)).toBe(true);
      expect(testCases.length).toBeGreaterThan(0);
    });

    it('should update test case (create new version)', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const updated = await asyncTestCaseStorage.update(createdTestCaseId, {
        name: updatedTestCaseName,
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe(updatedTestCaseName);
      expect(updated?.currentVersion).toBe(2);
    });

    it('should get test case versions', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const versions = await asyncTestCaseStorage.getVersions(createdTestCaseId);
      expect(Array.isArray(versions)).toBe(true);
      expect(versions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('asyncBenchmarkStorage', () => {
    let benchmarkId: string;
    // Unique per run; tracker-only cleanup (see note above).
    const benchmarkName = uniqueTestName('async-storage-benchmark');

    it('should create a benchmark', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: benchmarkName,
        description: 'Test benchmark',
        testCaseIds: ['tc-001', 'tc-002'],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: ['tc-001', 'tc-002'],
        }],
      });

      expect(benchmark).toBeDefined();
      expect(benchmark.id).toBeDefined();
      expect(benchmark.name).toBe(benchmarkName);
      benchmarkId = benchmark.id;
      tracker.benchmark(benchmark.id);
    });

    it('should get benchmark by ID', async () => {
      if (!backendAvailable || !benchmarkId) return;

      const benchmark = await asyncBenchmarkStorage.getById(benchmarkId);
      expect(benchmark).toBeDefined();
      expect(benchmark?.id).toBe(benchmarkId);
    });

    it('should get all benchmarks', async () => {
      if (!backendAvailable) return;

      const benchmarks = await asyncBenchmarkStorage.getAll();
      expect(Array.isArray(benchmarks)).toBe(true);
    });

    it('should delete run from benchmark', async () => {
      if (!backendAvailable || !benchmarkId) return;

      // First, we need to save a benchmark with runs
      // This tests the deleteRun method
      const result = await asyncBenchmarkStorage.deleteRun(benchmarkId, 'non-existent-run');
      expect(result).toBe(false); // Should return false since run doesn't exist
    });

    it('deleteRun removes a run that actually exists, against the REAL configured backend (true), and leaves the benchmark 404-safe once deleted (false)', async () => {
      // Regression test for the specific bug this method exists to prevent:
      // the OpenSearch adapter's removeIf painless script used to report
      // success for ANY run id on an existing benchmark — identical results
      // whether or not anything actually matched. Exercising ONLY the
      // "missing run" case (above) can't catch that, because both the correct
      // and the buggy implementation return `false` there. This drives the
      // full add → delete(true) → delete-again(false) → delete-on-missing-
      // benchmark(false) cycle against whichever backend `AH_PORT` actually
      // points at (the real OpenSearch adapter in this repo's shared-cluster
      // dev setup, not a mock).
      if (!backendAvailable) return;

      const bm = await asyncBenchmarkStorage.create({
        name: uniqueTestName('deleteRun-parity'),
        description: 'Integration test for deleteRun against the real backend',
        testCaseIds: [],
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [] }],
      });
      tracker.benchmark(bm.id);

      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const added = await asyncBenchmarkStorage.addRun(bm.id, {
        id: runId,
        status: 'pending',
      } as any);
      expect(added).toBe(true);

      // Sanity check: the run is actually there before we delete it.
      const withRun = await asyncBenchmarkStorage.getById(bm.id);
      expect(withRun?.runs?.some((r) => r.id === runId)).toBe(true);

      const deleted = await asyncBenchmarkStorage.deleteRun(bm.id, runId);
      expect(deleted).toBe(true);

      const withoutRun = await asyncBenchmarkStorage.getById(bm.id);
      expect(withoutRun?.runs?.some((r) => r.id === runId)).toBe(false);

      // Deleting the same (now-gone) run id again must be a safe no-match,
      // not a resurrected "success".
      const deletedAgain = await asyncBenchmarkStorage.deleteRun(bm.id, runId);
      expect(deletedAgain).toBe(false);

      // Missing benchmark entirely: must also be false, never throw.
      const missingBenchmark = await asyncBenchmarkStorage.deleteRun(
        `no-such-benchmark-${Date.now()}`,
        runId,
      );
      expect(missingBenchmark).toBe(false);
    });
  });

  describe('asyncRunStorage', () => {
    it('should get all reports', async () => {
      if (!backendAvailable) return;

      const reports = await asyncRunStorage.getAllReports({
        sortBy: 'timestamp',
        order: 'desc',
      });

      expect(Array.isArray(reports)).toBe(true);
    });

    it('should handle report not found', async () => {
      if (!backendAvailable) return;

      const report = await asyncRunStorage.getReportById('non-existent-id');
      expect(report).toBeNull();
    });
  });
});
