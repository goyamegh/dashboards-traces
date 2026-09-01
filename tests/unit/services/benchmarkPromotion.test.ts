/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { promoteRunToBenchmark, linkTestCaseIdsToBenchmark } from '@/services/benchmarkPromotion';
import type { Benchmark, EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

describe('promoteRunToBenchmark', () => {
  let mockStorage: jest.Mocked<Pick<IStorageModule, 'evaluationRuns' | 'benchmarks'>>;

  const mockRun: EvaluationRun = {
    id: 'run-1',
    docType: 'evaluation-run',
    name: 'Test Run',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    agentKey: 'test-agent',
    modelId: 'claude-sonnet',
    testCaseSnapshots: [
      { id: 'tc-1', version: 1, name: 'Case 1' },
      { id: 'tc-2', version: 2, name: 'Case 2' },
    ],
    results: {},
  } as unknown as EvaluationRun;

  const mockBenchmark: Benchmark = {
    id: 'bench-1',
    name: 'Promoted Benchmark',
    description: 'Promoted from run Test Run',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] }],
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
  };

  beforeEach(() => {
    mockStorage = {
      evaluationRuns: {
        getById: jest.fn(),
        update: jest.fn(),
      },
      benchmarks: {
        getAll: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    } as any;
  });

  it('should create a new benchmark from run snapshots', async () => {
    mockStorage.evaluationRuns.getById.mockResolvedValue(mockRun);
    mockStorage.benchmarks.getAll.mockResolvedValue({ items: [], total: 0 });
    mockStorage.benchmarks.create.mockResolvedValue(mockBenchmark);
    const updatedRun = { ...mockRun, benchmarkId: 'bench-1' };
    mockStorage.evaluationRuns.update.mockResolvedValue(updatedRun);

    const result = await promoteRunToBenchmark('run-1', 'Promoted Benchmark', mockStorage as any);

    expect(mockStorage.benchmarks.create).toHaveBeenCalledWith({
      name: 'Promoted Benchmark',
      testCaseIds: ['tc-1', 'tc-2'],
      description: 'Promoted from run Test Run',
    });
    expect(mockStorage.evaluationRuns.update).toHaveBeenCalledWith('run-1', { benchmarkId: 'bench-1' });
    expect(result.benchmark).toEqual(mockBenchmark);
    expect(result.run).toEqual(updatedRun);
  });

  it('should set benchmarkId on the run after promotion', async () => {
    mockStorage.evaluationRuns.getById.mockResolvedValue(mockRun);
    mockStorage.benchmarks.getAll.mockResolvedValue({ items: [], total: 0 });
    mockStorage.benchmarks.create.mockResolvedValue(mockBenchmark);
    const updatedRun = { ...mockRun, benchmarkId: 'bench-1' };
    mockStorage.evaluationRuns.update.mockResolvedValue(updatedRun);

    const result = await promoteRunToBenchmark('run-1', 'Promoted Benchmark', mockStorage as any);

    expect(mockStorage.evaluationRuns.update).toHaveBeenCalledWith('run-1', { benchmarkId: 'bench-1' });
    expect(result.run.benchmarkId).toBe('bench-1');
  });

  it('should reuse existing benchmark if name matches', async () => {
    const existingBenchmark: Benchmark = { ...mockBenchmark, id: 'existing-bench' };
    mockStorage.evaluationRuns.getById.mockResolvedValue(mockRun);
    mockStorage.benchmarks.getAll.mockResolvedValue({ items: [existingBenchmark], total: 1 });
    const updatedBenchmark = { ...existingBenchmark, testCaseIds: ['tc-1', 'tc-2'] };
    mockStorage.benchmarks.update.mockResolvedValue(updatedBenchmark);
    const updatedRun = { ...mockRun, benchmarkId: 'existing-bench' };
    mockStorage.evaluationRuns.update.mockResolvedValue(updatedRun);

    const result = await promoteRunToBenchmark('run-1', 'Promoted Benchmark', mockStorage as any);

    expect(mockStorage.benchmarks.create).not.toHaveBeenCalled();
    expect(mockStorage.benchmarks.update).toHaveBeenCalledWith('existing-bench', { testCaseIds: ['tc-1', 'tc-2'] });
    expect(result.benchmark).toEqual(updatedBenchmark);
    expect(result.run.benchmarkId).toBe('existing-bench');
  });

  it('should throw if run is not found', async () => {
    mockStorage.evaluationRuns.getById.mockResolvedValue(null);

    await expect(
      promoteRunToBenchmark('non-existent', 'Some Benchmark', mockStorage as any)
    ).rejects.toThrow('Evaluation run not found');

    expect(mockStorage.benchmarks.getAll).not.toHaveBeenCalled();
    expect(mockStorage.benchmarks.create).not.toHaveBeenCalled();
  });

  it('should throw if run already has a benchmarkId', async () => {
    const runWithBenchmark = { ...mockRun, benchmarkId: 'already-linked' };
    mockStorage.evaluationRuns.getById.mockResolvedValue(runWithBenchmark);

    await expect(
      promoteRunToBenchmark('run-1', 'Some Benchmark', mockStorage as any)
    ).rejects.toThrow('Run is already associated with a benchmark');

    expect(mockStorage.benchmarks.getAll).not.toHaveBeenCalled();
    expect(mockStorage.benchmarks.create).not.toHaveBeenCalled();
  });

  it('should use run.id in description when run has no name', async () => {
    const runWithoutName = { ...mockRun, name: '' };
    mockStorage.evaluationRuns.getById.mockResolvedValue(runWithoutName);
    mockStorage.benchmarks.getAll.mockResolvedValue({ items: [], total: 0 });
    mockStorage.benchmarks.create.mockResolvedValue(mockBenchmark);
    mockStorage.evaluationRuns.update.mockResolvedValue({ ...runWithoutName, benchmarkId: 'bench-1' });

    await promoteRunToBenchmark('run-1', 'New Benchmark', mockStorage as any);

    expect(mockStorage.benchmarks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Promoted from run run-1',
      })
    );
  });
});

/**
 * `linkTestCaseIdsToBenchmark` is now a thin, storage-agnostic delegator to
 * `storage.benchmarks.linkTestCaseIds()` -- the actual union-merge logic
 * (top-level + current-version repair, legacy-doc v1 synthesis,
 * multi-version targeting, dedup) moved into the OpenSearch/file adapters
 * themselves so the mutation can be genuinely atomic per-backend (a
 * codex_review finding: a client-side read-modify-write here, even with an
 * optimistic-retry freshness check, could still race on the final write).
 * See tests/unit/server/adapters/opensearch/StorageModule.test.ts
 * (`linkTestCaseIds` describe block) and
 * tests/unit/server/adapters/file/StorageModule.test.ts for the real
 * merge-logic and concurrency coverage.
 */
describe('linkTestCaseIdsToBenchmark', () => {
  let mockStorage: jest.Mocked<Pick<IStorageModule, 'benchmarks'>>;

  const shellBenchmark: Benchmark = {
    id: 'bench-shell',
    name: 'Shell Benchmark',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] }],
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
  };

  beforeEach(() => {
    mockStorage = {
      benchmarks: {
        getAll: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        addRun: jest.fn(),
        updateRun: jest.fn(),
        deleteRun: jest.fn(),
        bulkCreate: jest.fn(),
        linkTestCaseIds: jest.fn(),
      } as any,
    };
  });

  it('delegates to storage.benchmarks.linkTestCaseIds with the exact benchmarkId and testCaseIds, and returns its result verbatim', async () => {
    const expected = { benchmark: shellBenchmark, added: ['tc-1', 'tc-2'] };
    (mockStorage.benchmarks.linkTestCaseIds as jest.Mock).mockResolvedValue(expected);

    const result = await linkTestCaseIdsToBenchmark('bench-shell', ['tc-1', 'tc-2'], mockStorage as any);

    expect(mockStorage.benchmarks.linkTestCaseIds).toHaveBeenCalledWith('bench-shell', ['tc-1', 'tc-2']);
    expect(mockStorage.benchmarks.linkTestCaseIds).toHaveBeenCalledTimes(1);
    expect(result).toBe(expected);
  });

  it('passes through null when the benchmark does not exist (does not swallow or rewrap it)', async () => {
    (mockStorage.benchmarks.linkTestCaseIds as jest.Mock).mockResolvedValue(null);

    const result = await linkTestCaseIdsToBenchmark('missing-bench', ['tc-1'], mockStorage as any);

    expect(result).toBeNull();
  });

  it('propagates a rejection from the adapter (e.g. every retry_on_conflict/outer-retry attempt exhausted) rather than swallowing it', async () => {
    (mockStorage.benchmarks.linkTestCaseIds as jest.Mock).mockRejectedValue(new Error('adapter exhausted retries'));

    await expect(
      linkTestCaseIdsToBenchmark('bench-shell', ['tc-1'], mockStorage as any)
    ).rejects.toThrow('adapter exhausted retries');
  });
});
