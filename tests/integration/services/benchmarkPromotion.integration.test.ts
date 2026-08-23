/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { promoteRunToBenchmark } from '@/services/benchmarkPromotion';
import type { EvaluationRun } from '@/types';

describe('promoteRunToBenchmark (integration)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-promotion-test-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Helper to create an evaluation run
  // =========================================================================
  async function createRun(overrides: Partial<EvaluationRun> = {}): Promise<EvaluationRun> {
    return storage.evaluationRuns.create({
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      docType: 'evaluation-run',
      name: 'Test Run',
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'test-agent',
      modelId: 'test-model',
      sources: [],
      trigger: 'cli',
      testCaseSnapshots: [
        { id: 'tc-1', name: 'TC 1', version: 1 },
        { id: 'tc-2', name: 'TC 2', version: 1 },
      ],
      results: {},
      ...overrides,
    } as EvaluationRun);
  }

  // =========================================================================
  // Happy path: creates new benchmark
  // =========================================================================
  describe('creating a new benchmark', () => {
    it('promotes a run to a new benchmark', async () => {
      const run = await createRun();

      const result = await promoteRunToBenchmark(run.id, 'New Benchmark', storage);

      expect(result.benchmark).toBeDefined();
      expect(result.benchmark.name).toBe('New Benchmark');
      expect(result.benchmark.testCaseIds).toEqual(['tc-1', 'tc-2']);
      expect(result.benchmark.description).toContain(run.name || run.id);
      expect(result.run.benchmarkId).toBe(result.benchmark.id);
    });

    it('links the run to the newly created benchmark', async () => {
      const run = await createRun();

      const { benchmark, run: updatedRun } = await promoteRunToBenchmark(run.id, 'Linked Benchmark', storage);

      // Verify the run was persisted with the benchmarkId
      const fetchedRun = await storage.evaluationRuns.getById(updatedRun.id);
      expect(fetchedRun!.benchmarkId).toBe(benchmark.id);
    });
  });

  // =========================================================================
  // Happy path: updates existing benchmark
  // =========================================================================
  describe('updating an existing benchmark', () => {
    it('updates testCaseIds on an existing benchmark with matching name', async () => {
      // Create an existing benchmark with a known name
      const existingBenchmark = await storage.benchmarks.create({
        name: 'Existing Benchmark',
        testCaseIds: ['old-tc-1'],
      });

      // Create a run with different test case snapshots
      const run = await createRun({
        testCaseSnapshots: [
          { id: 'new-tc-1', name: 'New TC 1', version: 1 },
          { id: 'new-tc-2', name: 'New TC 2', version: 1 },
        ],
      } as Partial<EvaluationRun>);

      const result = await promoteRunToBenchmark(run.id, 'Existing Benchmark', storage);

      expect(result.benchmark.id).toBe(existingBenchmark.id);
      expect(result.benchmark.testCaseIds).toEqual(['new-tc-1', 'new-tc-2']);
      expect(result.run.benchmarkId).toBe(existingBenchmark.id);
    });
  });

  // =========================================================================
  // Error: run not found
  // =========================================================================
  describe('error cases', () => {
    it('throws when run not found', async () => {
      await expect(
        promoteRunToBenchmark('nonexistent-run-id', 'Some Benchmark', storage)
      ).rejects.toThrow('Evaluation run not found');
    });

    it('throws when run is already associated with a benchmark', async () => {
      const run = await createRun({ benchmarkId: 'existing-benchmark-id' } as Partial<EvaluationRun>);

      await expect(
        promoteRunToBenchmark(run.id, 'Another Benchmark', storage)
      ).rejects.toThrow('Run is already associated with a benchmark');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('handles a run with empty testCaseSnapshots', async () => {
      const run = await createRun({ testCaseSnapshots: [] } as Partial<EvaluationRun>);

      const result = await promoteRunToBenchmark(run.id, 'Empty Snapshots Benchmark', storage);

      expect(result.benchmark.testCaseIds).toEqual([]);
    });

    it('uses run name in description when available', async () => {
      const run = await createRun({ name: 'My Named Run' } as Partial<EvaluationRun>);

      const result = await promoteRunToBenchmark(run.id, 'Desc Test Benchmark', storage);

      expect(result.benchmark.description).toContain('My Named Run');
    });

    it('uses run id in description when name is empty', async () => {
      const run = await createRun({ name: '' } as Partial<EvaluationRun>);

      const result = await promoteRunToBenchmark(run.id, 'Desc ID Benchmark', storage);

      expect(result.benchmark.description).toContain(run.id);
    });
  });
});
