/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the pure BenchmarkRun-projection helpers in
 * server/routes/storage/evaluationRuns.ts:
 *   - buildStartingBenchmarkRunProjection
 *   - buildBenchmarkRunProjection
 *   - linkCompletedRunToBenchmark
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
  buildBenchmarkRunProjection,
  linkCompletedRunToBenchmark,
  syncCancelledBenchmarkProjection,
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

describe('buildBenchmarkRunProjection', () => {
  it('projects status/results/stats/completedAt from the run', () => {
    const run = makeRun({
      status: 'completed',
      results: { 'tc-1': { reportId: 'r-1', status: 'completed' } },
      stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
    });
    const projection = buildBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');

    expect(projection.status).toBe('completed');
    expect(projection.completedAt).toBe('2024-01-01T01:00:00.000Z');
    expect(projection.results).toEqual(run.results);
    expect(projection.stats).toEqual(run.stats);
  });

  it('includes error when the run failed', () => {
    const run = makeRun({ status: 'failed', error: 'agent crashed' });
    const projection = buildBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');
    expect(projection.status).toBe('failed');
    expect((projection as any).error).toBe('agent crashed');
  });

  it('omits error when the run has none', () => {
    const run = makeRun({ status: 'completed' });
    const projection = buildBenchmarkRunProjection(run, '2024-01-01T01:00:00.000Z');
    expect('error' in projection).toBe(false);
  });
});

describe('linkCompletedRunToBenchmark', () => {
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
    const projection = buildBenchmarkRunProjection(makeRun({ status: 'completed' }), 'now');

    await linkCompletedRunToBenchmark(storage, 'bm-1', projection);

    expect(updateRun).toHaveBeenCalledWith('bm-1', 'eval-run-1', projection);
    expect(addRun).not.toHaveBeenCalled();
  });

  it('falls back to addRun when the starting projection never landed, then follows up with an idempotent updateRun (TOCTOU guard)', async () => {
    const { storage, updateRun, addRun } = mockStorage({ id: 'bm-1', runs: [] });
    const projection = buildBenchmarkRunProjection(makeRun({ status: 'failed' }), 'now');

    await linkCompletedRunToBenchmark(storage, 'bm-1', projection);

    expect(addRun).toHaveBeenCalledWith('bm-1', projection);
    // Unconditional follow-up updateRun: guards a concurrent starting-link
    // winning the add-if-absent race between our read and this addRun call
    // — without this, that race would leave the OTHER writer's `running`
    // projection stuck forever with no terminal fields.
    expect(updateRun).toHaveBeenCalledWith('bm-1', projection.id, projection);
  });

  it('TOCTOU: succeeds via the updateRun follow-up even when addRun itself no-ops (lost the add race to a concurrent starting-link)', async () => {
    const { storage, updateRun, addRun } = mockStorage({ id: 'bm-1', runs: [] });
    // Simulates a concurrent starting-link landing between our getById read
    // and this addRun call: the real adapter's add-if-absent semantics would
    // return `true` (already present) without applying OUR terminal fields.
    addRun.mockResolvedValue(true);
    const projection = buildBenchmarkRunProjection(makeRun({ status: 'completed' }), 'now');

    await expect(linkCompletedRunToBenchmark(storage, 'bm-1', projection)).resolves.toBeUndefined();

    expect(updateRun).toHaveBeenCalledWith('bm-1', projection.id, projection);
  });

  it('throws only when BOTH the addRun and the follow-up updateRun fail', async () => {
    const { storage, updateRun, addRun } = mockStorage({ id: 'bm-1', runs: [] });
    addRun.mockResolvedValue(false);
    updateRun.mockResolvedValue(false);
    const projection = buildBenchmarkRunProjection(makeRun({ status: 'failed' }), 'now');

    await expect(linkCompletedRunToBenchmark(storage, 'bm-1', projection))
      .rejects.toThrow(/Failed to link/);
  });

  it('throws when the benchmark no longer exists', async () => {
    const { storage } = mockStorage(null);
    const projection = buildBenchmarkRunProjection(makeRun(), 'now');

    await expect(linkCompletedRunToBenchmark(storage, 'bm-missing', projection))
      .rejects.toThrow(/Benchmark not found/);
  });

  it('throws when the underlying write reports failure', async () => {
    const { storage, updateRun } = mockStorage({ id: 'bm-1', runs: [{ id: 'eval-run-1' }] });
    updateRun.mockResolvedValue(false);
    const projection = buildBenchmarkRunProjection(makeRun(), 'now');

    await expect(linkCompletedRunToBenchmark(storage, 'bm-1', projection))
      .rejects.toThrow(/Failed to link/);
  });
});

describe('syncCancelledBenchmarkProjection', () => {
  function mockStorage(benchmark: any) {
    const updateRun = jest.fn().mockResolvedValue(true);
    const addRun = jest.fn().mockResolvedValue(true);
    const getById = jest.fn().mockResolvedValue(benchmark);
    const storage = {
      benchmarks: { getById, updateRun, addRun },
    } as unknown as IStorageModule;
    return { storage, getById, updateRun, addRun };
  }

  it('writes a PARTIAL update (status/completedAt only) when the projection already exists, never touching results/stats', async () => {
    const { storage, updateRun, addRun } = mockStorage({
      id: 'bm-1',
      runs: [{ id: 'eval-run-1', status: 'running', results: { 'tc-1': { reportId: 'r1', status: 'completed' } } }],
    });
    const run = makeRun({ status: 'cancelled' });

    await syncCancelledBenchmarkProjection(storage, 'bm-1', run, '2024-01-01T02:00:00.000Z');

    expect(updateRun).toHaveBeenCalledWith('bm-1', 'eval-run-1', {
      status: 'cancelled',
      completedAt: '2024-01-01T02:00:00.000Z',
    });
    expect(addRun).not.toHaveBeenCalled();
  });

  it('includes error in the partial update when the run has one', async () => {
    const { storage, updateRun } = mockStorage({ id: 'bm-1', runs: [{ id: 'eval-run-1' }] });
    const run = makeRun({ status: 'cancelled', error: 'user requested' });

    await syncCancelledBenchmarkProjection(storage, 'bm-1', run, 'now');

    expect(updateRun).toHaveBeenCalledWith('bm-1', 'eval-run-1', {
      status: 'cancelled',
      completedAt: 'now',
      error: 'user requested',
    });
  });

  it('falls back to a full add-if-missing projection when nothing was linked yet', async () => {
    const { storage, updateRun, addRun } = mockStorage({ id: 'bm-1', runs: [] });
    const run = makeRun({ status: 'cancelled' });

    await syncCancelledBenchmarkProjection(storage, 'bm-1', run, 'now');

    expect(addRun).toHaveBeenCalledWith('bm-1', buildBenchmarkRunProjection(run, 'now'));
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('throws when the benchmark no longer exists', async () => {
    const { storage } = mockStorage(null);
    await expect(syncCancelledBenchmarkProjection(storage, 'bm-missing', makeRun(), 'now'))
      .rejects.toThrow(/Benchmark not found/);
  });

  it('throws when the partial updateRun reports failure', async () => {
    const { storage, updateRun } = mockStorage({ id: 'bm-1', runs: [{ id: 'eval-run-1' }] });
    updateRun.mockResolvedValue(false);
    await expect(syncCancelledBenchmarkProjection(storage, 'bm-1', makeRun(), 'now'))
      .rejects.toThrow(/Failed to sync/);
  });
});

describe('isEvaluationRunActiveInThisProcess', () => {
  it('returns false for a run id that was never registered', () => {
    expect(isEvaluationRunActiveInThisProcess('never-seen')).toBe(false);
  });
});
