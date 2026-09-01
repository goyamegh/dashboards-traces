/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { checkBenchmarkSourcesStillExist } from '@/services/evaluationRerun';
import type { Benchmark, EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'My Run',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: ['tc-1'] }],
    trigger: 'ui',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'Case 1' }],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: 'bm-1',
    name: 'My Benchmark',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] }],
    testCaseIds: ['tc-1'],
    runs: [],
    ...overrides,
  };
}

describe('checkBenchmarkSourcesStillExist', () => {
  let mockStorage: jest.Mocked<Pick<IStorageModule, 'benchmarks'>>;

  beforeEach(() => {
    mockStorage = {
      benchmarks: {
        getById: jest.fn(),
      } as any,
    };
  });

  it('returns null (no-op) when the run has no benchmark-type sources and no top-level benchmarkId', async () => {
    const run = makeRun();
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toBeNull();
    expect(mockStorage.benchmarks.getById).not.toHaveBeenCalled();
  });

  it('returns null when the referenced benchmark exists and no version is pinned', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(makeBenchmark());
    const run = makeRun({ sources: [{ type: 'benchmark', benchmarkId: 'bm-1' }] });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toBeNull();
    expect(mockStorage.benchmarks.getById).toHaveBeenCalledWith('bm-1');
  });

  it('returns null when the referenced benchmark exists and the pinned version still exists', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(makeBenchmark({
      currentVersion: 2,
      versions: [
        { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
        { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
      ],
    }));
    const run = makeRun({ sources: [{ type: 'benchmark', benchmarkId: 'bm-1', benchmarkVersion: 1 }] });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toBeNull();
  });

  it('returns a 409-worthy error when the referenced benchmark no longer exists', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(null);
    const run = makeRun({ sources: [{ type: 'benchmark', benchmarkId: 'deleted-bm' }] });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toMatch(/deleted-bm.*no longer exists/i);
  });

  it('returns a clear error when the pinned benchmark version no longer exists', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(makeBenchmark({
      currentVersion: 3,
      versions: [{ version: 3, createdAt: '2026-01-03T00:00:00Z', testCaseIds: ['tc-1'] }],
    }));
    const run = makeRun({ sources: [{ type: 'benchmark', benchmarkId: 'bm-1', benchmarkVersion: 1 }] });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toMatch(/version 1.*no longer exists/i);
    expect(result).toMatch(/current version: 3/i);
  });

  it('also validates the top-level benchmarkId/benchmarkVersion association, independent of sources', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(null);
    const run = makeRun({ sources: [{ type: 'test-case-ids', ids: ['tc-1'] }], benchmarkId: 'assoc-bm' });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toMatch(/assoc-bm.*no longer exists/i);
  });

  it('fetches a benchmark referenced from multiple places only once', async () => {
    mockStorage.benchmarks.getById.mockResolvedValue(makeBenchmark());
    const run = makeRun({
      sources: [{ type: 'benchmark', benchmarkId: 'bm-1' }],
      benchmarkId: 'bm-1',
    });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toBeNull();
    expect(mockStorage.benchmarks.getById).toHaveBeenCalledTimes(1);
  });

  it('checks BOTH pins when sources and the top-level association reference the same benchmark at DIFFERENT versions (codex_review finding)', async () => {
    // A source pins version 1 (still exists); the top-level association
    // (independently-written field) pins version 99 (does not). Deduping by
    // benchmarkId alone would drop the top-level check entirely because a
    // source entry for the same id was already "seen" — silently missing a
    // genuinely-broken pin. Deduping by the (id, version) pair catches it.
    mockStorage.benchmarks.getById.mockResolvedValue(makeBenchmark({
      currentVersion: 3,
      versions: [
        { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
        { version: 3, createdAt: '2026-01-03T00:00:00Z', testCaseIds: ['tc-1'] },
      ],
    }));
    const run = makeRun({
      sources: [{ type: 'benchmark', benchmarkId: 'bm-1', benchmarkVersion: 1 }],
      benchmarkId: 'bm-1',
      benchmarkVersion: 99,
    });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toMatch(/version 99/i);
    expect(result).toMatch(/no longer exists/i);
    // Still only one getById call — same benchmarkId, fetched once, checked twice.
    expect(mockStorage.benchmarks.getById).toHaveBeenCalledTimes(1);
  });

  it('checks every distinct benchmark referenced across multiple benchmark-type sources', async () => {
    mockStorage.benchmarks.getById.mockImplementation(async (id: string) =>
      id === 'bm-1' ? makeBenchmark({ id: 'bm-1' }) : null
    );
    const run = makeRun({
      sources: [
        { type: 'benchmark', benchmarkId: 'bm-1' },
        { type: 'benchmark', benchmarkId: 'bm-missing' },
      ],
    });
    const result = await checkBenchmarkSourcesStillExist(run, mockStorage);
    expect(result).toMatch(/bm-missing.*no longer exists/i);
  });
});
