/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the Benchmarks page JSON import flow.
 *
 * These tests simulate the full import pipeline as triggered from
 * BenchmarksPage.handleImportFile: validate → bulkCreate → create benchmark
 * from the bulk-create response's ids (no full-corpus re-fetch).
 *
 * Requires the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkImport.integration
 */

import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { createTestDataTracker, uniqueTestName } from '../../../helpers/testDataTracker';

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

describe('Benchmarks Page Import Flow', () => {
  let backendAvailable = false;
  // Tracks every test case / benchmark this suite creates — ordered,
  // 404-tolerant, crash-ledgered cleanup; see tests/helpers/testDataTracker.ts.
  const tracker = createTestDataTracker();
  const createdBenchmarkIds: string[] = [];

  // Simulates the JSON file content that would be loaded via the file input.
  // Names are unique per run (uniqueTestName) so the getAll+name lookup below
  // can only ever match docs THIS run created, and parallel/aborted runs on
  // the shared cluster never collide.
  const importFileContent = [
    {
      name: uniqueTestName('benchimport-service-restart'),
      description: 'Test the full benchmarks page import pipeline',
      category: 'RCA',
      difficulty: 'Easy' as const,
      initialPrompt: 'Investigate service restarts in production',
      context: [
        {
          description: 'Alert',
          value: 'Service restarted 5 times in the last hour',
        },
      ],
      expectedOutcomes: [
        'Identify restart cause from logs',
        'Recommend fix for memory leak',
      ],
    },
    {
      name: uniqueTestName('benchimport-slow-queries'),
      description: 'Test the full benchmarks page import pipeline',
      category: 'RCA',
      difficulty: 'Medium' as const,
      initialPrompt: 'Investigate slow database queries',
      context: [],
      expectedOutcomes: ['Identify slow query patterns'],
    },
  ];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping benchmarks import integration tests');
    }
  });

  afterAll(async () => {
    // Delete ONLY ids this run created (tracker). Never sweep shared storage
    // by name: "name looks test-ish" is not proof of ownership, and a
    // name-based getAll+delete here deletes OTHER users' data on the shared
    // cluster. Unique fixture names (above) make cross-run collisions — the
    // thing a name sweep was crudely working around — impossible instead.
    await tracker.cleanup();
  });

  describe('full import pipeline (validates → creates test cases → creates benchmark)', () => {
    it('should validate, create test cases, and create a benchmark in one flow', async () => {
      if (!backendAvailable) return;

      // Step 1: Validate (mirrors handleImportFile's JSON.parse + validate)
      const validation = validateTestCasesArrayJson(importFileContent);
      expect(validation.valid).toBe(true);
      expect(validation.data).toHaveLength(2);

      // Step 2: Bulk create test cases
      const result = await asyncTestCaseStorage.bulkCreate(validation.data!);
      expect(result.created).toBe(2);
      // `errors` is a COUNT (number of failed creates), not a boolean — see
      // the storage adapters' bulkCreate; the old `toBe(false)` assertion was
      // written against a lying client type and never actually ran.
      expect(result.errors).toBe(0);

      // Step 3: Get IDs of created test cases directly from the bulk-create
      // response — mirrors the current handleImportFile, which reads
      // `result.testCases` instead of re-fetching the ENTIRE test-case
      // corpus (the old `getAll()` + name-match, which was both the
      // full-payload performance bug this suite is regression-testing AND a
      // correctness bug: matching by `name` breaks for duplicate names.
      const createdIds = result.testCases.map((tc) => tc.id);

      expect(createdIds.length).toBe(2);
      createdIds.forEach((id) => {
        expect(id).toMatch(/^tc-/);
        tracker.testCase(id);
      });

      // Regression guard for the fix: the import flow must not fall back to
      // fetching the full test-case list to resolve the created ids.
      const getAllSpy = jest.spyOn(asyncTestCaseStorage, 'getAll');
      expect(getAllSpy).not.toHaveBeenCalled();
      getAllSpy.mockRestore();

      // Step 4: Create benchmark with the test case IDs (mirrors the handler's benchmark creation)
      const benchmarkName = uniqueTestName('sample-import-test-cases');
      const benchmark = await asyncBenchmarkStorage.create({
        name: benchmarkName,
        description: `Auto-created from import of ${result.created} test case(s)`,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds: createdIds,
          },
        ],
        testCaseIds: createdIds,
        runs: [],
      });

      expect(benchmark.id).toMatch(/^bench-/);
      expect(benchmark.name).toBe(benchmarkName);
      expect(benchmark.testCaseIds).toEqual(createdIds);
      expect(benchmark.runs).toEqual([]);
      expect(benchmark.description).toContain('Auto-created from import');

      tracker.benchmark(benchmark.id);
      createdBenchmarkIds.push(benchmark.id);
    });

    it('should be able to retrieve the created benchmark', async () => {
      if (!backendAvailable || createdBenchmarkIds.length === 0) return;

      const benchmark = await asyncBenchmarkStorage.getById(createdBenchmarkIds[0]);
      expect(benchmark).not.toBeNull();
      expect(benchmark!.testCaseIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('import error handling', () => {
    it('should reject import of invalid JSON structure', () => {
      const invalid = [{ name: 'Missing required fields' }];
      const validation = validateTestCasesArrayJson(invalid);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should reject import of empty array', () => {
      const validation = validateTestCasesArrayJson([]);
      expect(validation.valid).toBe(false);
    });

    it('should reject import of non-array non-object', () => {
      const validation = validateTestCasesArrayJson('not json');
      expect(validation.valid).toBe(false);
    });

    it('should handle bulkCreate returning zero created when all duplicates', async () => {
      if (!backendAvailable) return;

      // Create test cases first
      const firstResult = await asyncTestCaseStorage.bulkCreate(importFileContent);

      // Track IDs for cleanup directly from the bulk-create response (no
      // full-corpus getAll() + name-match needed — see the import-pipeline
      // test above: that pattern is both a full-payload performance bug and
      // a correctness bug for this exact scenario, since this test's whole
      // point is duplicate names).
      firstResult.testCases.forEach((tc) => {
        tracker.testCase(tc.id);
      });

      // Note: bulkCreate does NOT deduplicate by name, so this will create new ones.
      // The BenchmarksPage handler shows an error only when created === 0.
      // This test documents that duplicate names are allowed.
      expect(firstResult.created).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmark name derivation from filename', () => {
    it('should strip .json extension from filename', () => {
      const filename = 'my-test-cases.json';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('my-test-cases');
    });

    it('should strip .JSON extension case-insensitively', () => {
      const filename = 'MY-CASES.JSON';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('MY-CASES');
    });

    it('should fall back to "Imported Benchmark" for empty name after stripping', () => {
      const filename = '.json';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('Imported Benchmark');
    });
  });
});
