/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeBenchmarkLeaderboard,
  getBenchmarksWithCompletedRuns,
  isRunCompleted,
  formatPassRateFraction,
  formatPassRatePercent,
} from '@/lib/benchmarkLeaderboard';
import type { Benchmark, BenchmarkRun } from '@/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<BenchmarkRun> & { id: string; agentKey: string }): BenchmarkRun {
  // Nullish coalescing can't distinguish "omitted" from "explicitly undefined"
  // (both are undefined), and a couple of tests rely on that distinction to
  // exercise the legacy no-status branch of isRunCompleted. Use `in` instead.
  const status = 'status' in overrides ? overrides.status : 'completed';
  return {
    id: overrides.id,
    name: overrides.name ?? `Run ${overrides.id}`,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    status,
    agentKey: overrides.agentKey,
    modelId: overrides.modelId ?? 'claude-sonnet',
    results: overrides.results ?? {},
    stats: overrides.stats,
  } as BenchmarkRun;
}

// results shaped as the denormalized production data: passFailStatus lives
// directly on each results[testCaseId] entry (evaluationRunner.ts persists
// it there at run-completion time), NOT only on the separate report.
function resultsOf(verdicts: Array<'passed' | 'failed' | 'errored'>): BenchmarkRun['results'] {
  const results: BenchmarkRun['results'] = {};
  verdicts.forEach((v, i) => {
    results[`tc-${i}`] = {
      reportId: `report-${i}`,
      status: 'completed',
      ...(v === 'errored' ? {} : { passFailStatus: v }),
    } as BenchmarkRun['results'][string];
  });
  return results;
}

function makeBenchmark(id: string, name: string, runs: BenchmarkRun[]): Benchmark {
  return {
    id,
    name,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: [],
    runs,
  };
}

// ─── isRunCompleted ──────────────────────────────────────────────────────────

describe('isRunCompleted', () => {
  it('is true for an explicit completed status', () => {
    expect(isRunCompleted(makeRun({ id: 'r1', agentKey: 'a', status: 'completed' }))).toBe(true);
  });

  it('is false for running/pending/failed/cancelled status', () => {
    for (const status of ['running', 'pending', 'failed', 'cancelled'] as const) {
      expect(isRunCompleted(makeRun({ id: 'r1', agentKey: 'a', status }))).toBe(false);
    }
  });

  it('treats legacy (no status) runs as completed only if every result resolved', () => {
    const allResolved = makeRun({
      id: 'r1', agentKey: 'a', status: undefined,
      results: resultsOf(['passed', 'failed']),
    });
    expect(isRunCompleted(allResolved)).toBe(true);

    const stillRunning = makeRun({
      id: 'r2', agentKey: 'a', status: undefined,
      results: { 'tc-0': { reportId: 'x', status: 'running' } } as BenchmarkRun['results'],
    });
    expect(isRunCompleted(stillRunning)).toBe(false);
  });

  it('treats a legacy run with no results at all as not completed', () => {
    expect(isRunCompleted(makeRun({ id: 'r1', agentKey: 'a', status: undefined, results: {} }))).toBe(false);
  });
});

// ─── computeBenchmarkLeaderboard: aggregation + latest-per-agent ───────────

describe('computeBenchmarkLeaderboard — latest run per agent', () => {
  it('picks the LATEST completed run per agentKey, not the best one', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({
        id: 'run-old-good', agentKey: 'agent-a', createdAt: '2024-01-01T00:00:00Z',
        results: resultsOf(['passed', 'passed', 'passed', 'passed']), // 4/4 = 100%
      }),
      makeRun({
        id: 'run-new-bad', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z',
        results: resultsOf(['passed', 'failed', 'failed', 'failed']), // 1/4 = 25%
      }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows).toHaveLength(1);
    expect(rows[0].run.id).toBe('run-new-bad');
    expect(rows[0].passRate).toBeCloseTo(25, 5);
  });

  it('ignores runs that are not completed when picking the latest', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({
        id: 'run-completed', agentKey: 'agent-a', createdAt: '2024-01-01T00:00:00Z',
        results: resultsOf(['passed', 'passed']),
      }),
      makeRun({
        id: 'run-still-running', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z',
        status: 'running',
        results: resultsOf(['passed']),
      }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows).toHaveLength(1);
    expect(rows[0].run.id).toBe('run-completed');
  });

  it('groups independently per agentKey', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-a', agentKey: 'agent-a', results: resultsOf(['passed', 'passed']) }),
      makeRun({ id: 'run-b', agentKey: 'agent-b', results: resultsOf(['failed', 'failed']) }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows.map(r => r.agentKey).sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('returns an empty list when the benchmark has no completed runs', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-a', agentKey: 'agent-a', status: 'running', results: resultsOf(['passed']) }),
    ]);
    expect(computeBenchmarkLeaderboard(bm)).toEqual([]);
  });
});

// ─── computeBenchmarkLeaderboard: ranking ───────────────────────────────────

describe('computeBenchmarkLeaderboard — ranking', () => {
  it('ranks by pass rate descending', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-low', agentKey: 'agent-low', results: resultsOf(['passed', 'failed', 'failed', 'failed']) }), // 25%
      makeRun({ id: 'run-high', agentKey: 'agent-high', results: resultsOf(['passed', 'passed', 'passed', 'failed']) }), // 75%
      makeRun({ id: 'run-mid', agentKey: 'agent-mid', results: resultsOf(['passed', 'passed', 'failed', 'failed']) }), // 50%
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows.map(r => r.agentKey)).toEqual(['agent-high', 'agent-mid', 'agent-low']);
    expect(rows.map(r => Math.round(r.passRate))).toEqual([75, 50, 25]);
  });

  it('breaks ties by more evaluable test cases (more evidence ranks higher)', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-small', agentKey: 'agent-small', results: resultsOf(['passed', 'passed']) }), // 2/2 = 100%
      makeRun({ id: 'run-big', agentKey: 'agent-big', results: resultsOf(['passed', 'passed', 'passed', 'passed', 'passed']) }), // 5/5 = 100%
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows.map(r => r.agentKey)).toEqual(['agent-big', 'agent-small']);
  });

  it('breaks fully-tied rows by agentKey for a deterministic order', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-z', agentKey: 'zeta', results: resultsOf(['passed']) }),
      makeRun({ id: 'run-a', agentKey: 'alpha', results: resultsOf(['passed']) }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows.map(r => r.agentKey)).toEqual(['alpha', 'zeta']);
  });
});

// ─── computeBenchmarkLeaderboard: N/M + canonical bucketing ────────────────

describe('computeBenchmarkLeaderboard — N/M bucketing (canonical, errored excluded)', () => {
  it('excludes errored test cases from both the numerator and the denominator', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({
        id: 'run-a', agentKey: 'agent-a',
        // 1 passed, 1 failed, 1 errored (judge couldn't produce a verdict).
        results: resultsOf(['passed', 'failed', 'errored']),
      }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.passed).toBe(1);
    expect(row.failed).toBe(1);
    expect(row.errored).toBe(1);
    expect(row.total).toBe(3);
    // Evaluable excludes the errored case: 1 passed + 1 failed = 2, NOT 3.
    expect(row.evaluable).toBe(2);
    expect(row.passRate).toBeCloseTo(50, 5);
    expect(formatPassRateFraction(row)).toBe('1/2');
  });

  it('falls back to denormalized run.stats when results is empty', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({
        id: 'run-a', agentKey: 'agent-a', results: {},
        stats: { passed: 7, failed: 3, pending: 0, errored: 0, total: 10 },
      }),
    ]);

    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows[0].passed).toBe(7);
    expect(rows[0].evaluable).toBe(10);
    expect(rows[0].passRate).toBeCloseTo(70, 5);
  });

  it('reports 0% (not NaN) when there are zero evaluable test cases', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'run-a', agentKey: 'agent-a', results: resultsOf(['errored', 'errored']) }),
    ]);
    const rows = computeBenchmarkLeaderboard(bm);
    expect(rows[0].evaluable).toBe(0);
    expect(rows[0].passRate).toBe(0);
    expect(formatPassRateFraction(rows[0])).toBe('0/0');
  });
});

// ─── getBenchmarksWithCompletedRuns ─────────────────────────────────────────

describe('getBenchmarksWithCompletedRuns', () => {
  it('excludes benchmarks with zero completed runs', () => {
    const withRuns = makeBenchmark('bm-with', 'Has runs', [
      makeRun({ id: 'r1', agentKey: 'a', results: resultsOf(['passed']) }),
    ]);
    const withoutRuns = makeBenchmark('bm-without', 'No completed runs', [
      makeRun({ id: 'r1', agentKey: 'a', status: 'running', results: resultsOf(['passed']) }),
    ]);
    const noRunsAtAll = makeBenchmark('bm-empty', 'Empty', []);

    const options = getBenchmarksWithCompletedRuns([withRuns, withoutRuns, noRunsAtAll]);
    expect(options.map(o => o.id)).toEqual(['bm-with']);
  });

  it('orders by most-recent completed run descending, so index 0 is the default preselection', () => {
    const stale = makeBenchmark('bm-stale', 'Stale', [
      makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-01-01T00:00:00Z', results: resultsOf(['passed']) }),
    ]);
    const fresh = makeBenchmark('bm-fresh', 'Fresh', [
      makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-06-01T00:00:00Z', results: resultsOf(['passed']) }),
    ]);
    const mid = makeBenchmark('bm-mid', 'Mid', [
      makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-03-01T00:00:00Z', results: resultsOf(['passed']) }),
    ]);

    const options = getBenchmarksWithCompletedRuns([stale, fresh, mid]);
    expect(options.map(o => o.id)).toEqual(['bm-fresh', 'bm-mid', 'bm-stale']);
  });

  it('uses the most recent completed run, ignoring newer non-completed runs, for ordering', () => {
    const bm = makeBenchmark('bm-1', 'Bench', [
      makeRun({ id: 'r-old-completed', agentKey: 'a', createdAt: '2024-01-01T00:00:00Z', results: resultsOf(['passed']) }),
      makeRun({ id: 'r-new-running', agentKey: 'a', createdAt: '2024-09-01T00:00:00Z', status: 'running', results: resultsOf(['passed']) }),
    ]);
    const options = getBenchmarksWithCompletedRuns([bm]);
    expect(options[0].lastCompletedRunAt).toBe('2024-01-01T00:00:00Z');
  });
});

// ─── Formatting helpers ──────────────────────────────────────────────────────

describe('formatPassRateFraction / formatPassRatePercent', () => {
  it('formats the fraction as passed/evaluable', () => {
    expect(formatPassRateFraction({ passed: 8, evaluable: 10 })).toBe('8/10');
    expect(formatPassRateFraction({ passed: 0, evaluable: 0 })).toBe('0/0');
  });

  it('formats the percent with exactly one decimal place', () => {
    expect(formatPassRatePercent(66.66666)).toBe('66.7%');
    expect(formatPassRatePercent(100)).toBe('100.0%');
    expect(formatPassRatePercent(0)).toBe('0.0%');
  });
});
