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

describe('linkTestCaseIdsToBenchmark', () => {
  let mockStorage: jest.Mocked<Pick<IStorageModule, 'benchmarks'>>;

  const shellBenchmark: Benchmark = {
    id: 'bench-shell',
    name: 'Shell Benchmark',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: [] }],
    testCaseIds: [],
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
      } as any,
    };
  });

  it('returns null when the benchmark does not exist', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(null);

    const result = await linkTestCaseIdsToBenchmark('missing-bench', ['tc-1'], mockStorage as any);

    expect(result).toBeNull();
    expect(mockStorage.benchmarks.update).not.toHaveBeenCalled();
  });

  it('is a no-op when every id is already present (no write, no version bump)', async () => {
    const benchmark = { ...shellBenchmark, testCaseIds: ['tc-1', 'tc-2'] };
    mockStorage.benchmarks.getById.mockResolvedValue(benchmark);

    const result = await linkTestCaseIdsToBenchmark('bench-shell', ['tc-1', 'tc-2'], mockStorage as any);

    expect(result).toEqual({ benchmark, added: [] });
    expect(mockStorage.benchmarks.update).not.toHaveBeenCalled();
  });

  it('unions new ids into testCaseIds and bumps the version (repairs a shell benchmark)', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(shellBenchmark);
    const updated = {
      ...shellBenchmark,
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 2,
    };
    mockStorage.benchmarks.update.mockResolvedValue(updated);

    const result = await linkTestCaseIdsToBenchmark('bench-shell', ['tc-1', 'tc-2'], mockStorage as any);

    expect(mockStorage.benchmarks.update).toHaveBeenCalledWith('bench-shell', expect.objectContaining({
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 2,
    }));
    const call = mockStorage.benchmarks.update.mock.calls[0][1] as any;
    expect(call.versions).toHaveLength(2);
    expect(call.versions[1].testCaseIds).toEqual(['tc-1', 'tc-2']);
    expect(result).toEqual({ benchmark: updated, added: ['tc-1', 'tc-2'] });
  });

  it('only adds ids not already present, keeping existing order first', async () => {
    const benchmark = { ...shellBenchmark, testCaseIds: ['tc-1'] };
    mockStorage.benchmarks.getById.mockResolvedValue(benchmark);
    mockStorage.benchmarks.update.mockImplementation(async (_id, updates) => ({ ...benchmark, ...updates }));

    const result = await linkTestCaseIdsToBenchmark('bench-shell', ['tc-1', 'tc-2', 'tc-3'], mockStorage as any);

    expect(result?.added).toEqual(['tc-2', 'tc-3']);
    const call = mockStorage.benchmarks.update.mock.calls[0][1] as any;
    expect(call.testCaseIds).toEqual(['tc-1', 'tc-2', 'tc-3']);
  });

  it('deduplicates ids within the input list itself', async () => {
    const benchmark = { ...shellBenchmark, testCaseIds: [] };
    mockStorage.benchmarks.getById.mockResolvedValue(benchmark);
    mockStorage.benchmarks.update.mockImplementation(async (_id, updates) => ({ ...benchmark, ...updates }));

    const result = await linkTestCaseIdsToBenchmark('bench-shell', ['tc-1', 'tc-1', 'tc-2'], mockStorage as any);

    expect(result?.added).toEqual(['tc-1', 'tc-2']);
  });

  it('handles a benchmark with no versions array yet (legacy doc) by synthesizing v1', async () => {
    const legacyBenchmark: any = {
      id: 'bench-legacy',
      name: 'Legacy',
      createdAt: '2025-01-01T00:00:00Z',
      testCaseIds: [],
      runs: [],
    };
    mockStorage.benchmarks.getById.mockResolvedValue(legacyBenchmark);
    mockStorage.benchmarks.update.mockImplementation(async (_id, updates) => ({ ...legacyBenchmark, ...updates }));

    await linkTestCaseIdsToBenchmark('bench-legacy', ['tc-1'], mockStorage as any);

    const call = mockStorage.benchmarks.update.mock.calls[0][1] as any;
    expect(call.currentVersion).toBe(2);
    expect(call.versions).toHaveLength(2);
    expect(call.versions[0]).toEqual({ version: 1, createdAt: '2025-01-01T00:00:00Z', testCaseIds: [] });
  });
});
