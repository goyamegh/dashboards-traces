/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the pure BenchmarkRun-projection helpers in
 * server/routes/storage/evaluationRuns.ts:
 *   - buildStartingBenchmarkRunProjection
 *   - buildTerminalBenchmarkRunProjection
 *   - linkTerminalBenchmarkRunProjection
 *   - isEvaluationRunActiveInThisProcess
 *
 * These are the building blocks the create/cancel routes and the boot-time
 * evaluation-run recovery module use to keep `benchmark.runs` (the embedded
 * projection the Benchmark Details page reads) in sync with the top-level
 * EvaluationRun doc through every phase of a run's life. Regression target:
 * a running/failed evaluation-run-based run silently invisible on the
 * Benchmark Details page (see CHANGELOG entry for this fix).
 */

import {
  buildStartingBenchmarkRunProjection,
  buildTerminalBenchmarkRunProjection,
  linkTerminalBenchmarkRunProjection,
  isEvaluationRunActiveInThisProcess,
} from '@/server/routes/storage/evaluationRuns';
import type { EvaluationRun } from '@/types/index';
import type { IStorageModule } from '@/server/adapters/types';

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'Test Run',
    createdAt: '2024-01-01T00:00:00.000Z',
    status: 'running',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [
      { id: 'tc-1', version: 1, name: 'TC 1' },
      { id: 'tc-2', version: 1, name: 'TC 2' },
    ],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

describe('buildStartingBenchmarkRunProjection', () => {
  it('seeds every snapshot test case as pending and sets status running', () => {
    const run = makeRun();
    const projection = buildStartingBenchmarkRunProjection(run, 3);

    expect(projection.id).toBe('eval-run-1');
    expect(projection.status).toBe('running');
    expect(projection.benchmarkVersion).toBe(3);
    expect(projection.results).toEqual({
      'tc-1': { reportId: '', status: 'pending' },
      'tc-2': { reportId: '', status: 'pending' },
    });
    expect(projection.testCaseSnapshots).toEqual(run.testCaseSnapshots);
  });

  it('omits benchmarkVersion when not provided', () => {
    const projection = buildStartingBenchmarkRunProjection(makeRun());
    expect(projection.benchmarkVersion).toBeUndefined();
  });

  it('preserves falsy-but-meaningful fields (concurrency: 0, empty description)', () => {
    const projection = buildStartingBenchmarkRunProjection(
      makeRun({ concurrency: 0, description: '' })
    );
    expect(projection.concurrency).toBe(0);
    expect(projection.description).toBe('');
  });

  it('drops fields that are genuinely absent (undefined)', () => {
    const projection = buildStartingBenchmarkRunProjection(makeRun({ concurrency: undefined, description: undefined }));
    expect('concurrency' in projection).toBe(false);
    expect('description' in projection).toBe(false);
  });

  it('handles a run with no test case snapshots (empty results, not a crash)', () => {
    const projection = buildStartingBenchmarkRunProjection(makeRun({ testCaseSnapshots: [] }));
    expect(projection.results).toEqual({});
  });
});

describe('buildTerminalBenchmarkRunProjection', () => {
  it('projects status/results/stats/completedAt from the run', () => {
    const run = makeRun({
      status: 'completed',
      results: { 'tc-1': { reportId: 'r-1', status: 'completed' } },
      stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
    });
    const projection = buildTerminalBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');

    expect(projection.status).toBe('completed');
    expect(projection.completedAt).toBe('2024-01-01T01:00:00.000Z');
    expect(projection.results).toEqual(run.results);
    expect(projection.stats).toEqual(run.stats);
  });

  it('includes error when the run failed', () => {
    const run = makeRun({ status: 'failed', error: 'agent crashed' });
    const projection = buildTerminalBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');
    expect(projection.status).toBe('failed');
    expect((projection as any).error).toBe('agent crashed');
  });

  it('omits error when the run has none', () => {
    const run = makeRun({ status: 'completed' });
    const projection = buildTerminalBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');
    expect('error' in projection).toBe(false);
  });
});

describe('linkTerminalBenchmarkRunProjection', () => {
  function mockStorage(benchmark: any) {
    const updateRun = jest.fn().mockResolvedValue(true);
    const addRun = jest.fn().mockResolvedValue(true);
    const getById = jest.fn().mockResolvedValue(benchmark);
    const storage = {
      benchmarks: { getById, updateRun, addRun },
    } as unknown as IStorageModule;
    return { storage, getById, updateRun, addRun };
  }

  it('UPDATEs an already-linked run instead of calling addRun again', async () => {
    const { storage, updateRun, addRun } = mockStorage({
      id: 'bm-1',
      runs: [{ id: 'eval-run-1', status: 'running' }],
    });
    const projection = buildTerminalBenchmarkRunProjection(makeRun({ status: 'completed' }), 'now');

    await linkTerminalBenchmarkRunProjection(storage, 'bm-1', projection);

    expect(updateRun).toHaveBeenCalledWith('bm-1', 'eval-run-1', projection);
    expect(addRun).not.toHaveBeenCalled();
  });

  it('falls back to addRun when the starting projection never landed', async () => {
    const { storage, updateRun, addRun } = mockStorage({ id: 'bm-1', runs: [] });
    const projection = buildTerminalBenchmarkRunProjection(makeRun({ status: 'failed' }), 'now');

    await linkTerminalBenchmarkRunProjection(storage, 'bm-1', projection);

    expect(addRun).toHaveBeenCalledWith('bm-1', projection);
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('throws when the benchmark no longer exists', async () => {
    const { storage } = mockStorage(null);
    const projection = buildTerminalBenchmarkRunProjection(makeRun(), 'now');

    await expect(linkTerminalBenchmarkRunProjection(storage, 'bm-missing', projection))
      .rejects.toThrow(/Benchmark not found/);
  });

  it('throws when the underlying write reports failure', async () => {
    const { storage, updateRun } = mockStorage({ id: 'bm-1', runs: [{ id: 'eval-run-1' }] });
    updateRun.mockResolvedValue(false);
    const projection = buildTerminalBenchmarkRunProjection(makeRun(), 'now');

    await expect(linkTerminalBenchmarkRunProjection(storage, 'bm-1', projection))
      .rejects.toThrow(/Failed to link/);
  });
});

describe('isEvaluationRunActiveInThisProcess', () => {
  it('returns false for a run id that was never registered', () => {
    expect(isEvaluationRunActiveInThisProcess('never-seen')).toBe(false);
  });
});
