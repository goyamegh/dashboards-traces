/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recoverOrphanEvaluationRuns,
  recoverOrphanEvaluationRunsSafely,
} from '@/server/services/evaluationRunRecoveryOnBoot';
import * as evaluationRunsRoute from '@/server/routes/storage/evaluationRuns';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/server/routes/storage/evaluationRuns', () => {
  const actual = jest.requireActual('@/server/routes/storage/evaluationRuns');
  return {
    ...actual,
    isEvaluationRunActiveInThisProcess: jest.fn().mockReturnValue(false),
  };
});

const mockIsActive = evaluationRunsRoute.isEvaluationRunActiveInThisProcess as jest.MockedFunction<
  typeof evaluationRunsRoute.isEvaluationRunActiveInThisProcess
>;

interface MockOpts {
  runs: any[];
  listThrows?: boolean;
  updateThrowsFor?: Set<string>;
  benchmarks?: Record<string, any>;
  benchmarkGetByIdThrowsFor?: Set<string>;
}

function mockStorage(opts: MockOpts) {
  const updateCalls: Array<{ id: string; updates: any }> = [];
  const runs = JSON.parse(JSON.stringify(opts.runs));
  const benchmarks: Record<string, any> = JSON.parse(JSON.stringify(opts.benchmarks || {}));

  const storage: Partial<IStorageModule> = {
    evaluationRuns: {
      list: jest.fn().mockImplementation(async ({ from = 0, size = 100 }: any = {}) => {
        if (opts.listThrows) throw new Error('cluster down');
        const running = runs.filter((r: any) => r.status === 'running');
        const slice = running.slice(from, from + size);
        return { items: slice, total: running.length };
      }),
      update: jest.fn().mockImplementation(async (id: string, updates: any) => {
        if (opts.updateThrowsFor?.has(id)) throw new Error(`update ${id} failed`);
        updateCalls.push({ id, updates });
        const idx = runs.findIndex((r: any) => r.id === id);
        if (idx >= 0) runs[idx] = { ...runs[idx], ...updates };
        return runs[idx];
      }),
    } as any,
    benchmarks: {
      getById: jest.fn().mockImplementation(async (id: string) => {
        if (opts.benchmarkGetByIdThrowsFor?.has(id)) throw new Error(`getById ${id} failed`);
        return benchmarks[id] || null;
      }),
      updateRun: jest.fn().mockImplementation(async (benchmarkId: string, runId: string, updates: any) => {
        const bm = benchmarks[benchmarkId];
        if (!bm) return false;
        const idx = (bm.runs || []).findIndex((r: any) => r.id === runId);
        if (idx === -1) return false;
        bm.runs[idx] = { ...bm.runs[idx], ...updates };
        return true;
      }),
      addRun: jest.fn().mockImplementation(async (benchmarkId: string, run: any) => {
        const bm = benchmarks[benchmarkId];
        if (!bm) return false;
        bm.runs = bm.runs || [];
        if (bm.runs.some((r: any) => r.id === run.id)) return true;
        bm.runs.push(run);
        return true;
      }),
    } as any,
  };
  return { storage: storage as IStorageModule, updateCalls, benchmarks };
}

const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago
const recently = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago

function run(overrides: any) {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'Test Run',
    createdAt: longAgo,
    status: 'running',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  };
}

describe('recoverOrphanEvaluationRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActive.mockReturnValue(false);
    delete process.env.EVALUATION_RUN_RECOVERY_DISABLED;
    delete process.env.EVALUATION_RUN_STALE_AFTER_MS;
    delete process.env.EVALUATION_RUN_RECOVERY_PAGE_SIZE;
  });

  it('marks unstarted (pending, no reportId) results as failed and the run as failed', async () => {
    const runs = [run({
      results: {
        tcA: { reportId: 'r1', status: 'completed' },
        tcB: { reportId: '', status: 'pending' },
        tcC: { reportId: '', status: 'running' },
        tcD: { reportId: 'r2', status: 'completed' },
      },
    })];
    const { storage, updateCalls } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.staleRuns).toBe(1);
    expect(stat.runsMarkedFailed).toBe(1);
    expect(stat.resultsMarkedFailed).toBe(2);
    expect(stat.errors).toBe(0);

    expect(updateCalls).toHaveLength(1);
    const updated = updateCalls[0].updates;
    expect(updated.status).toBe('failed');
    expect(updated.results.tcA.status).toBe('completed');
    expect(updated.results.tcB.status).toBe('failed');
    expect(updated.results.tcB.error).toMatch(/boot recovery/);
    expect(updated.results.tcC.status).toBe('failed');
    expect(updated.results.tcD.status).toBe('completed');
  });

  it('syncs the benchmark.runs projection to failed when the run has a benchmarkId', async () => {
    const runs = [run({ benchmarkId: 'bm-1', results: { a: { reportId: '', status: 'pending' } } })];
    const benchmarks = { 'bm-1': { id: 'bm-1', runs: [{ id: 'eval-run-1', status: 'running' }] } };
    const { storage, benchmarks: bms } = mockStorage({ runs, benchmarks });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.benchmarkProjectionsSynced).toBe(1);
    expect(bms['bm-1'].runs[0].status).toBe('failed');
  });

  it('does not touch benchmark.runs for ad-hoc runs (no benchmarkId)', async () => {
    const runs = [run({ results: { a: { reportId: '', status: 'pending' } } })];
    const { storage, benchmarks } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.benchmarkProjectionsSynced).toBe(0);
    expect(Object.keys(benchmarks)).toHaveLength(0);
  });

  it('counts an error but keeps the run marked failed when the benchmark projection sync fails', async () => {
    const runs = [run({ benchmarkId: 'bm-missing', results: { a: { reportId: '', status: 'pending' } } })];
    const { storage, updateCalls } = mockStorage({ runs }); // benchmarks map empty -> getById returns null

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.runsMarkedFailed).toBe(1);
    expect(stat.errors).toBe(1);
    expect(stat.benchmarkProjectionsSynced).toBe(0);
    expect(updateCalls[0].updates.status).toBe('failed');
  });

  it('skips runs that are not running', async () => {
    const runs = [
      run({ id: 'run-1', status: 'completed' }),
      run({ id: 'run-2', status: 'failed' }),
      run({ id: 'run-3', status: 'cancelled' }),
    ];
    const { storage, updateCalls } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('skips running runs that are still recent', async () => {
    const runs = [run({ createdAt: recently, results: { tcA: { reportId: '', status: 'pending' } } })];
    const { storage, updateCalls } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('skips runs that are still active in the current process', async () => {
    mockIsActive.mockImplementation((id) => id === 'eval-run-1');
    const runs = [run({ id: 'eval-run-1' })];
    const { storage, updateCalls } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('honours EVALUATION_RUN_STALE_AFTER_MS env override', async () => {
    process.env.EVALUATION_RUN_STALE_AFTER_MS = '60'; // 60ms — everything fresh becomes stale
    const runs = [run({ createdAt: new Date(Date.now() - 10_000).toISOString(), results: { a: { reportId: '', status: 'pending' } } })];
    const { storage } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);
    expect(stat.staleRuns).toBe(1);
    expect(stat.resultsMarkedFailed).toBe(1);
  });

  it('counts errors when evaluationRuns.list fails and stops paging', async () => {
    const { storage } = mockStorage({ runs: [], listThrows: true });
    const stat = await recoverOrphanEvaluationRuns(storage);
    expect(stat.errors).toBe(1);
    expect(stat.scannedRuns).toBe(0);
  });

  it('counts errors but continues when a run update fails', async () => {
    const runs = [
      run({ id: 'eval-run-1', results: { a: { reportId: '', status: 'pending' } } }),
      run({ id: 'eval-run-2', results: { b: { reportId: '', status: 'pending' } } }),
    ];
    const { storage } = mockStorage({ runs, updateThrowsFor: new Set(['eval-run-1']) });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.errors).toBe(1);
    expect(stat.staleRuns).toBe(2);
    expect(stat.runsMarkedFailed).toBe(1); // only eval-run-2 succeeded
  });

  it('EVALUATION_RUN_RECOVERY_DISABLED=1 short-circuits', async () => {
    process.env.EVALUATION_RUN_RECOVERY_DISABLED = '1';
    const runs = [run({ results: { a: { reportId: '', status: 'pending' } } })];
    const { storage, updateCalls } = mockStorage({ runs });

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.scannedRuns).toBe(0);
    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(storage.evaluationRuns.list).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanEvaluationRunsSafely', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never throws even when storage explodes', async () => {
    const storage = {
      evaluationRuns: { list: jest.fn().mockRejectedValue(new Error('boom')) } as any,
    } as unknown as IStorageModule;

    await expect(recoverOrphanEvaluationRunsSafely(storage)).resolves.toBeUndefined();
  });

  it('logs a summary line', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const runs = [run({ results: { a: { reportId: '', status: 'pending' } } })];
    const { storage } = mockStorage({ runs });

    await recoverOrphanEvaluationRunsSafely(storage);
    const summary = log.mock.calls.map(c => c.join(' ')).find(line => line.includes('[evaluationRunRecovery]'));
    expect(summary).toBeDefined();
    log.mockRestore();
  });
});
