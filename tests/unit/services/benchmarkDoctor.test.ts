/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildDoctorPlan, applyDoctorPlan, migrateBenchmarksToImages } from '@/services/benchmarkDoctor';
import type { DoctorStorageOps, DoctorPlan } from '@/services/benchmarkDoctor';
import type { Benchmark, EvaluationRun } from '@/types';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z'; // way older than 24h
const FRESH = '2026-05-31T23:30:00.000Z'; // 30 min old

function bench(overrides: Partial<Benchmark> & { id: string; name: string }): Benchmark {
  return {
    description: '',
    createdAt: OLD,
    updatedAt: OLD,
    currentVersion: 1,
    versions: [],
    testCaseIds: [],
    runs: [],
    ...overrides,
  } as Benchmark;
}

function run(id: string, benchmarkId?: string): EvaluationRun {
  return {
    id,
    docType: 'evaluation-run',
    name: id,
    createdAt: OLD,
    status: 'completed',
    agentKey: 'a',
    modelId: 'm',
    sources: [],
    trigger: 'cli',
    testCaseSnapshots: [],
    results: {},
    ...(benchmarkId ? { benchmarkId } : {}),
  } as EvaluationRun;
}

describe('buildDoctorPlan — debris detection', () => {
  it('flags quick-<ts> and *-<epoch-ms> benchmarks with no runs anywhere', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767' }),
        bench({ id: 'b2', name: 'sdk-cli-coverage-1787518298767' }),
        bench({ id: 'b3', name: 'My Real Benchmark' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions.map((d) => d.id).sort()).toEqual(['b1', 'b2']);
  });

  it('never flags debris that has embedded runs or eval-run references', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767', runs: [{ id: 'r' } as any] }),
        bench({ id: 'b2', name: 'quick-1787518298768' }),
      ],
      [run('er-1', 'b2')],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
  });

  it('never flags debris younger than 24h (in-flight shells are safe)', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'b1', name: 'quick-1787518298767', createdAt: FRESH })],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
  });

  it('never touches sample data', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'demo-quick', name: 'quick-1787518298767' })],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
    expect(plan.summary.totalBenchmarks).toBe(0);
  });
});

describe('buildDoctorPlan — content duplicates', () => {
  it('groups benchmarks with the same testCaseIds set (order-insensitive)', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'A', testCaseIds: ['tc-1', 'tc-2'] }),
        bench({ id: 'b2', name: 'A copy', testCaseIds: ['tc-2', 'tc-1'] }),
        bench({ id: 'b3', name: 'Different', testCaseIds: ['tc-3'] }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups).toHaveLength(1);
    expect(plan.contentDupGroups[0].husks).toHaveLength(1);
  });

  it('empty test-case sets are never treated as "same content"', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'Shell A' }),
        bench({ id: 'b2', name: 'Shell B' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups).toEqual([]);
  });

  it('canonical is the member with most embedded runs, then refs, then oldest', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b-old', name: 'oldest', testCaseIds: ['tc-1'], createdAt: '2025-01-01T00:00:00.000Z' }),
        bench({ id: 'b-runs', name: 'has runs', testCaseIds: ['tc-1'], runs: [{ id: 'r1' } as any] }),
        bench({ id: 'b-new', name: 'newest', testCaseIds: ['tc-1'], createdAt: '2026-05-01T00:00:00.000Z' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups[0].canonicalId).toBe('b-runs');
    expect(plan.contentDupGroups[0].husks.map((h) => h.id).sort()).toEqual(['b-new', 'b-old']);
  });

  it('plans re-points for eval-runs referencing husks', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'canonical', testCaseIds: ['tc-1'], runs: [{ id: 'r1' } as any] }),
        bench({ id: 'b2', name: 'husk', testCaseIds: ['tc-1'] }),
      ],
      [run('er-1', 'b2'), run('er-2', 'b2'), run('er-3', 'b1')],
      { now: NOW }
    );
    const group = plan.contentDupGroups[0];
    expect(group.canonicalId).toBe('b1');
    expect(group.runRepoints).toEqual([
      { runId: 'er-1', fromBenchmarkId: 'b2', toBenchmarkId: 'b1' },
      { runId: 'er-2', fromBenchmarkId: 'b2', toBenchmarkId: 'b1' },
    ]);
    expect(plan.summary.runsToRepoint).toBe(2);
  });

  it('a debris deletion removes the doc from dup grouping (no double-handling)', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767', testCaseIds: ['tc-1'] }),
        bench({ id: 'b2', name: 'real', testCaseIds: ['tc-1'] }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions.map((d) => d.id)).toEqual(['b1']);
    expect(plan.contentDupGroups).toEqual([]); // b2 alone is not a group
  });
});

describe('buildDoctorPlan — clean state', () => {
  it('returns an empty plan when nothing is wrong', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'b1', name: 'Healthy', testCaseIds: ['tc-1'] })],
      [run('er-1', 'b1')],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
    expect(plan.contentDupGroups).toEqual([]);
    expect(plan.summary).toEqual({
      totalBenchmarks: 1,
      debrisCount: 0,
      dupGroupCount: 0,
      husksToMerge: 0,
      runsToRepoint: 0,
    });
  });
});

function mockApi(overrides: Partial<DoctorStorageOps> = {}): DoctorStorageOps {
  return {
    getBenchmark: jest.fn().mockResolvedValue(null),
    updateBenchmark: jest.fn().mockResolvedValue(bench({ id: 'x', name: 'x' })),
    deleteBenchmark: jest.fn().mockResolvedValue(true),
    updateEvaluationRun: jest.fn().mockResolvedValue(run('er-x')),
    listBenchmarks: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function emptyPlan(overrides: Partial<DoctorPlan> = {}): DoctorPlan {
  return {
    debrisDeletions: [],
    contentDupGroups: [],
    summary: { totalBenchmarks: 0, debrisCount: 0, dupGroupCount: 0, husksToMerge: 0, runsToRepoint: 0 },
    ...overrides,
  };
}

describe('applyDoctorPlan — error branches', () => {
  it('records an error and skips the group when the canonical is already gone', async () => {
    const api = mockApi({ getBenchmark: jest.fn().mockResolvedValue(null) });
    const plan = emptyPlan({
      contentDupGroups: [
        { key: 'k', canonicalId: 'canon-1', canonicalName: 'Canon', husks: [], runRepoints: [] },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.errors).toEqual(['canonical not found: canon-1']);
    expect(result.husksDeleted).toBe(0);
    expect(api.updateBenchmark).not.toHaveBeenCalled();
  });

  it('merges embedded runs from husks, re-points eval-runs, then deletes husks', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon', runs: [{ id: 'run-shared' } as any] });
    const husk = bench({ id: 'husk-1', name: 'Husk', runs: [{ id: 'run-shared' } as any, { id: 'run-only-husk' } as any] });
    const getBenchmark = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'canon-1') return canonical;
      if (id === 'husk-1') return husk;
      return null;
    });
    const api = mockApi({ getBenchmark });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [{ id: 'husk-1', name: 'Husk', embeddedRunCount: 2 }],
          runRepoints: [{ runId: 'er-1', fromBenchmarkId: 'husk-1', toBenchmarkId: 'canon-1' }],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.embeddedRunsMerged).toBe(1); // only 'run-only-husk' is new
    expect(api.updateBenchmark).toHaveBeenCalledWith('canon-1', {
      runs: [{ id: 'run-shared' }, { id: 'run-only-husk' }],
    });
    expect(result.runsRepointed).toBe(1);
    expect(result.husksDeleted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('skips a husk that is already gone without error', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon' });
    const getBenchmark = jest.fn().mockImplementation(async (id: string) => (id === 'canon-1' ? canonical : null));
    const api = mockApi({ getBenchmark });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [{ id: 'husk-gone', name: 'Gone', embeddedRunCount: 0 }],
          runRepoints: [],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.husksDeleted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('records a re-point failure when updateEvaluationRun returns null', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon' });
    const api = mockApi({
      getBenchmark: jest.fn().mockResolvedValue(canonical),
      updateEvaluationRun: jest.fn().mockResolvedValue(null),
    });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [],
          runRepoints: [{ runId: 'er-1', fromBenchmarkId: 'husk-1', toBenchmarkId: 'canon-1' }],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.errors).toEqual(['failed to re-point run er-1']);
    expect(result.runsRepointed).toBe(0);
  });

  it('never deletes a husk whose re-point failed — the eval-run still points at it', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon' });
    const husk = bench({ id: 'husk-1', name: 'Husk' });
    const getBenchmark = jest.fn().mockImplementation(async (id: string) => (id === 'canon-1' ? canonical : husk));
    const deleteBenchmark = jest.fn().mockResolvedValue(true);
    const api = mockApi({
      getBenchmark,
      updateEvaluationRun: jest.fn().mockResolvedValue(null), // re-point fails
      deleteBenchmark,
    });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [{ id: 'husk-1', name: 'Husk', embeddedRunCount: 0 }],
          runRepoints: [{ runId: 'er-1', fromBenchmarkId: 'husk-1', toBenchmarkId: 'canon-1' }],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.runsRepointed).toBe(0);
    expect(result.husksDeleted).toBe(0);
    expect(deleteBenchmark).not.toHaveBeenCalledWith('husk-1');
    expect(result.errors).toEqual([
      'failed to re-point run er-1',
      'skipped deleting husk husk-1: a run re-point to it failed',
    ]);
  });

  it('still deletes OTHER husks in the same group whose re-point succeeded', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon' });
    const huskOk = bench({ id: 'husk-ok', name: 'HuskOk' });
    const huskFail = bench({ id: 'husk-fail', name: 'HuskFail' });
    const getBenchmark = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'canon-1') return canonical;
      if (id === 'husk-ok') return huskOk;
      if (id === 'husk-fail') return huskFail;
      return null;
    });
    const updateEvaluationRun = jest.fn().mockImplementation(async (id: string) =>
      id === 'er-ok' ? run('er-ok') : null
    );
    const api = mockApi({ getBenchmark, updateEvaluationRun });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [
            { id: 'husk-ok', name: 'HuskOk', embeddedRunCount: 0 },
            { id: 'husk-fail', name: 'HuskFail', embeddedRunCount: 0 },
          ],
          runRepoints: [
            { runId: 'er-ok', fromBenchmarkId: 'husk-ok', toBenchmarkId: 'canon-1' },
            { runId: 'er-fail', fromBenchmarkId: 'husk-fail', toBenchmarkId: 'canon-1' },
          ],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.husksDeleted).toBe(1);
    expect(result.errors).toEqual([
      'failed to re-point run er-fail',
      'skipped deleting husk husk-fail: a run re-point to it failed',
    ]);
  });

  it('records a husk-delete failure when deleteBenchmark returns false', async () => {
    const canonical = bench({ id: 'canon-1', name: 'Canon' });
    const husk = bench({ id: 'husk-1', name: 'Husk' });
    const getBenchmark = jest.fn().mockImplementation(async (id: string) => (id === 'canon-1' ? canonical : husk));
    const api = mockApi({ getBenchmark, deleteBenchmark: jest.fn().mockResolvedValue(false) });
    const plan = emptyPlan({
      contentDupGroups: [
        {
          key: 'k',
          canonicalId: 'canon-1',
          canonicalName: 'Canon',
          husks: [{ id: 'husk-1', name: 'Husk', embeddedRunCount: 0 }],
          runRepoints: [],
        },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.errors).toEqual(['failed to delete husk husk-1']);
    expect(result.husksDeleted).toBe(0);
  });

  it('catches a thrown error mid-group and records it without aborting the whole plan', async () => {
    const api = mockApi({ getBenchmark: jest.fn().mockRejectedValue(new Error('storage down')) });
    const plan = emptyPlan({
      contentDupGroups: [
        { key: 'k', canonicalId: 'canon-1', canonicalName: 'Canon', husks: [], runRepoints: [] },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.errors).toEqual(['group Canon: storage down']);
  });

  it('deletes debris and records both successes and failures', async () => {
    const deleteBenchmark = jest.fn().mockImplementation(async (id: string) => id !== 'debris-fail');
    const api = mockApi({ deleteBenchmark });
    const plan = emptyPlan({
      debrisDeletions: [
        { id: 'debris-ok', name: 'OK debris', reason: 'quick-mode' },
        { id: 'debris-fail', name: 'Stubborn debris', reason: 'quick-mode' },
      ],
    });
    const result = await applyDoctorPlan(api, plan);
    expect(result.debrisDeleted).toBe(1);
    expect(result.errors).toEqual(['failed to delete debris debris-fail']);
  });

  it('catches a thrown error deleting debris', async () => {
    const api = mockApi({ deleteBenchmark: jest.fn().mockRejectedValue(new Error('boom')) });
    const plan = emptyPlan({ debrisDeletions: [{ id: 'd1', name: 'D1', reason: 'quick-mode' }] });
    const result = await applyDoctorPlan(api, plan);
    expect(result.errors).toEqual(['debris D1: boom']);
  });
});

describe('migrateBenchmarksToImages', () => {
  const BASE_URL = 'http://localhost:9999';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('skips sample (demo-) and empty-test-case benchmarks without calling the API', async () => {
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([
        bench({ id: 'demo-1', name: 'Sample', testCaseIds: ['tc-1'] }),
        bench({ id: 'b-empty', name: 'Empty', testCaseIds: [] }),
      ]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { benchmarkId: 'demo-1', name: 'Sample', reason: 'sample data' },
      { benchmarkId: 'b-empty', name: 'Empty', reason: 'no test cases' },
    ]);
    expect(result.migrated).toEqual([]);
  });

  it('defaults to dryRun:true — previews the real digest/tags via the server, and requests dryRun without opts.dryRun', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ image: { digest: 'sha256:abc' }, alreadyExists: false }),
    });
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([
        bench({ id: 'b1', name: 'Keep', testCaseIds: ['tc-1'] }),
      ]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL);
    expect(result.dryRun).toBe(true);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(requestInit.body).dryRun).toBe(true);
    expect(result.migrated).toEqual([
      { benchmarkId: 'b1', name: 'Keep', digest: 'sha256:abc', alreadyExists: false },
    ]);
  });

  it('opts.dryRun: false actually executes the migration (dryRun omitted from the result entries)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ image: { digest: 'sha256:abc' } }),
    });
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([
        bench({ id: 'b1', name: 'Keep', testCaseIds: ['tc-1'] }),
        bench({ id: 'b2', name: 'Drop', testCaseIds: ['tc-2'] }),
      ]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL, { benchmarkIds: ['b1'], dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(requestInit.body).dryRun).toBe(false);
    expect(result.migrated).toEqual([{ benchmarkId: 'b1', name: 'Keep', digest: 'sha256:abc' }]);
  });

  it('records an error when the images API responds non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, text: async () => 'boom from server' });
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([bench({ id: 'b1', name: 'Keep', testCaseIds: ['tc-1'] })]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL, { dryRun: false });
    expect(result.errors).toEqual(['Keep: boom from server']);
    expect(result.migrated).toEqual([]);
  });

  it('records an error when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([bench({ id: 'b1', name: 'Keep', testCaseIds: ['tc-1'] })]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL, { dryRun: false });
    expect(result.errors).toEqual(['Keep: network down']);
  });

  it('surfaces a partial migration (missing test-case ids) as migrated-with-a-loud-warning, not a silent success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ image: { digest: 'sha256:partial' }, missingTestCaseIds: ['tc-gone'] }),
    });
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([
        bench({ id: 'b1', name: 'Partial', testCaseIds: ['tc-1', 'tc-gone'] }),
      ]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL, { dryRun: false });
    expect(result.migrated).toEqual([
      { benchmarkId: 'b1', name: 'Partial', digest: 'sha256:partial', missingTestCaseIds: ['tc-gone'] },
    ]);
    expect(result.errors).toEqual([
      'Partial: migrated from a PARTIAL test-case set — missing 1 id(s): tc-gone',
    ]);
  });

  it('dry-run partial migration warning says "would migrate", not "migrated"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ image: { digest: 'sha256:partial' }, missingTestCaseIds: ['tc-gone'], alreadyExists: false }),
    });
    const api = mockApi({
      listBenchmarks: jest.fn().mockResolvedValue([
        bench({ id: 'b1', name: 'Partial', testCaseIds: ['tc-1', 'tc-gone'] }),
      ]),
    });
    const result = await migrateBenchmarksToImages(api, BASE_URL);
    expect(result.errors).toEqual([
      'Partial: would migrate from a PARTIAL test-case set — missing 1 id(s): tc-gone',
    ]);
  });
});
