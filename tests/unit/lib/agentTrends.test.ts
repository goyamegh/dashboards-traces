/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildAgentRunPoints,
  buildAgentTrendRows,
  buildBenchmarkDotPlotRows,
  buildGapBrokenSeries,
  computeLatestDelta,
  formatDelta,
  formatMetricValue,
  getMostRecentlyActiveBenchmarkId,
  getRunAccuracy,
  groupPointsByAgent,
  metricDomain,
  metricValue,
  rankDotPlotRows,
  sortAgentTrendRows,
  timeRangeToSinceMs,
  valueToPercent,
  type AgentRunPoint,
  type RunMetricsLookup,
} from '@/lib/agentTrends';
import type { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRun(overrides: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'Run 1',
    createdAt: '2024-06-01T00:00:00.000Z',
    agentKey: 'agent-a',
    modelId: 'claude-sonnet',
    results: {},
    ...overrides,
  };
}

function makeBenchmark(id: string, name: string, runs: BenchmarkRun[]): Benchmark {
  return {
    id,
    name,
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2024-01-01T00:00:00.000Z', testCaseIds: [] }],
    testCaseIds: [],
    runs,
  };
}

function makeReport(overrides: Partial<EvaluationReport>): EvaluationReport {
  return {
    id: overrides.id || 'report-1',
    timestamp: '2024-06-01T00:00:00.000Z',
    testCaseId: 'tc-1',
    agentName: 'Agent A',
    modelName: 'claude-sonnet',
    status: 'completed',
    passFailStatus: 'passed',
    trajectory: [],
    metrics: { accuracy: 100 },
    llmJudgeReasoning: '',
    ...overrides,
  } as EvaluationReport;
}

/** Minimal AgentRunPoint builder for tests that exercise pure series/row shaping without going through buildAgentRunPoints. */
function makePoint(overrides: Partial<AgentRunPoint>): AgentRunPoint {
  return {
    runDocId: 'r', benchmarkId: 'b', benchmarkName: 'B', agentKey: 'agent-a', agentName: 'Agent A',
    modelId: 'm', createdAt: new Date(overrides.timestamp ?? 0).toISOString(), timestamp: 0,
    passed: 1, failed: 0, total: 1, accuracyPct: 100, costUsd: null, tokens: null,
    ...overrides,
  };
}

describe('agentTrends', () => {
  describe('getRunAccuracy', () => {
    it('prefers denormalized run.stats when present', () => {
      const run = makeRun({ stats: { passed: 3, failed: 1, pending: 0, total: 4 } });
      expect(getRunAccuracy(run)).toEqual({ passed: 3, failed: 1, total: 4, accuracyPct: 75 });
    });

    it('excludes errored test cases from the accuracy denominator', () => {
      const run = makeRun({ stats: { passed: 2, failed: 1, pending: 0, errored: 1, total: 4 } });
      // evaluable = 4 - 1 = 3; 2/3 = 66.67%
      expect(getRunAccuracy(run).accuracyPct).toBeCloseTo((2 / 3) * 100, 5);
    });

    it('falls back to bucketing run.results when stats are absent', () => {
      const run = makeRun({
        results: {
          'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } as any,
          'tc-2': { reportId: 'r2', status: 'completed', passFailStatus: 'failed' } as any,
        },
      });
      const result = getRunAccuracy(run);
      expect(result.total).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.accuracyPct).toBe(50);
    });

    // Owner-reported bug fix ("stray 0.0% points"): a run where every test
    // case errored (no judge verdict at all) used to report accuracyPct: 0,
    // which is visually indistinguishable from a genuine "passed nothing"
    // result. It must now report `null` — "no accuracy signal" — so callers
    // (buildGapBrokenSeries, row summaries) can drop it instead of plotting
    // a fake zero.
    it('returns null (not 0) for a run with zero evaluable test cases', () => {
      const run = makeRun({ stats: { passed: 0, failed: 0, pending: 0, errored: 2, total: 2 } });
      expect(getRunAccuracy(run).accuracyPct).toBeNull();
    });

    it('returns null (not 0/NaN) when run.stats.total is 0 and results is empty (falls back to bucketing, still zero evaluable)', () => {
      const run = makeRun({ stats: undefined, results: {} });
      expect(getRunAccuracy(run).accuracyPct).toBeNull();
    });
  });

  describe('timeRangeToSinceMs', () => {
    const now = new Date('2024-06-30T00:00:00.000Z').getTime();
    it('computes 7d/30d/90d cutoffs relative to now', () => {
      expect(timeRangeToSinceMs('7d', now)).toBe(now - 7 * DAY_MS);
      expect(timeRangeToSinceMs('30d', now)).toBe(now - 30 * DAY_MS);
      expect(timeRangeToSinceMs('90d', now)).toBe(now - 90 * DAY_MS);
    });
  });

  describe('buildAgentRunPoints', () => {
    it('builds one point per run, grouped and time-sorted, with accuracy from run.stats', () => {
      const bm = makeBenchmark('bm-1', 'Benchmark One', [
        makeRun({ id: 'run-1', agentKey: 'agent-a', createdAt: '2024-06-02T00:00:00.000Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
        makeRun({ id: 'run-2', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00.000Z', stats: { passed: 5, failed: 5, pending: 0, total: 10 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      expect(points.map(p => p.runDocId)).toEqual(['run-2', 'run-1']); // ascending time
      expect(points[1].accuracyPct).toBe(80);
      expect(points[1].costUsd).toBeNull();
      expect(points[1].tokens).toBeNull();
    });

    it('skips runs with zero test cases', () => {
      const bm = makeBenchmark('bm-1', 'B', [makeRun({ id: 'run-empty', stats: { passed: 0, failed: 0, pending: 0, total: 0 } })]);
      expect(buildAgentRunPoints([bm], [], new Map())).toHaveLength(0);
    });

    it('filters by benchmarkId and sinceMs', () => {
      const bmA = makeBenchmark('bm-a', 'A', [makeRun({ id: 'run-a', createdAt: '2024-06-10T00:00:00.000Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } })]);
      const bmB = makeBenchmark('bm-b', 'B', [makeRun({ id: 'run-b', createdAt: '2024-01-01T00:00:00.000Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } })]);

      const filteredByBenchmark = buildAgentRunPoints([bmA, bmB], [], new Map(), { benchmarkId: 'bm-a' });
      expect(filteredByBenchmark.map(p => p.runDocId)).toEqual(['run-a']);

      const filteredByTime = buildAgentRunPoints([bmA, bmB], [], new Map(), {
        sinceMs: new Date('2024-06-01T00:00:00.000Z').getTime(),
      });
      expect(filteredByTime.map(p => p.runDocId)).toEqual(['run-a']);
    });

    it('sums matched trace metrics across a run\'s reports via experimentRunId, leaving unmatched runs null', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'run-1', stats: { passed: 2, failed: 0, pending: 0, total: 2 } }),
      ]);
      const reports: EvaluationReport[] = [
        makeReport({ id: 'r1', experimentRunId: 'run-1', runId: 'agent-run-1' }),
        makeReport({ id: 'r2', experimentRunId: 'run-1', runId: 'agent-run-2' }),
      ];
      const metricsMap = new Map<string, RunMetricsLookup>([
        ['agent-run-1', { costUsd: 0.5, tokens: 1000 }],
        ['agent-run-2', { costUsd: 0.3, tokens: 500 }],
      ]);
      const [point] = buildAgentRunPoints([bm], reports, metricsMap);
      expect(point.costUsd).toBeCloseTo(0.8, 6);
      expect(point.tokens).toBe(1500);
    });

    it('nulls out cost/tokens when only SOME of a run\'s reports resolved trace metrics (no partial totals presented as complete)', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'run-1', stats: { passed: 2, failed: 0, pending: 0, total: 2 } }),
      ]);
      const reports: EvaluationReport[] = [
        makeReport({ id: 'r1', experimentRunId: 'run-1', runId: 'agent-run-1' }),
        makeReport({ id: 'r2', experimentRunId: 'run-1', runId: 'agent-run-2' }), // no trace match
      ];
      const metricsMap = new Map<string, RunMetricsLookup>([
        ['agent-run-1', { costUsd: 0.5, tokens: 1000 }],
        // agent-run-2 intentionally has no entry
      ]);
      const [point] = buildAgentRunPoints([bm], reports, metricsMap);
      expect(point.costUsd).toBeNull();
      expect(point.tokens).toBeNull();
    });

    it('uses the agentDisplayName callback when provided', () => {
      const bm = makeBenchmark('bm-1', 'B', [makeRun({ agentKey: 'agent-a', stats: { passed: 1, failed: 0, pending: 0, total: 1 } })]);
      const points = buildAgentRunPoints([bm], [], new Map(), { agentDisplayName: k => `Pretty ${k}` });
      expect(points[0].agentName).toBe('Pretty agent-a');
    });
  });

  describe('groupPointsByAgent', () => {
    it('groups while preserving relative (time-sorted) order', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
        makeRun({ id: 'r2', agentKey: 'b', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
        makeRun({ id: 'r3', agentKey: 'a', createdAt: '2024-06-03T00:00:00Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const grouped = groupPointsByAgent(points);
      expect(grouped.get('a')!.map(p => p.runDocId)).toEqual(['r1', 'r3']);
      expect(grouped.get('b')!.map(p => p.runDocId)).toEqual(['r2']);
    });
  });

  describe('metricValue', () => {
    const point = makePoint({ accuracyPct: 100, costUsd: 1.5, tokens: 100 });
    it('reads the right field per metric key', () => {
      expect(metricValue(point, 'accuracy')).toBe(100);
      expect(metricValue(point, 'cost')).toBe(1.5);
      expect(metricValue(point, 'tokens')).toBe(100);
    });

    it('returns null for accuracy when the point has no accuracy signal', () => {
      expect(metricValue(makePoint({ accuracyPct: null }), 'accuracy')).toBeNull();
    });
  });

  describe('formatMetricValue', () => {
    it('formats accuracy as a percentage with 1 decimal', () => {
      expect(formatMetricValue('accuracy', 83.456)).toBe('83.5%');
    });
    it('formats cost via formatCost', () => {
      expect(formatMetricValue('cost', 0.5)).toMatch(/\$/);
    });
    it('formats tokens via formatTokens', () => {
      expect(formatMetricValue('tokens', 15000)).toMatch(/k|K|\d/);
    });
  });

  describe('buildGapBrokenSeries (per-agent series + gap-breaking)', () => {
    it('plots consecutive runs within the gap threshold as one unbroken series (no synthetic breaks)', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: 3 * DAY_MS, accuracyPct: 70 }),
        makePoint({ timestamp: 6 * DAY_MS, accuracyPct: 80 }),
      ];
      const series = buildGapBrokenSeries(points, 'accuracy');
      expect(series).toHaveLength(3);
      expect(series.every(s => s.value != null)).toBe(true);
    });

    it('inserts a null-valued break between two runs more than 7 days apart', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: 20 * DAY_MS, accuracyPct: 80 }), // 20-day gap > 7-day default threshold
      ];
      const series = buildGapBrokenSeries(points, 'accuracy');
      expect(series).toHaveLength(3); // real, break, real
      expect(series[0].value).toBe(60);
      expect(series[1].value).toBeNull();
      expect(series[1].point).toBeNull();
      expect(series[1].timestamp).toBe(10 * DAY_MS); // midpoint
      expect(series[2].value).toBe(80);
    });

    it('respects a custom gapBreakMs threshold', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: 2 * DAY_MS, accuracyPct: 70 }),
      ];
      // 2-day gap: no break at the (default) 7-day threshold...
      expect(buildGapBrokenSeries(points, 'accuracy')).toHaveLength(2);
      // ...but breaks at a 1-day threshold.
      expect(buildGapBrokenSeries(points, 'accuracy', 1 * DAY_MS)).toHaveLength(3);
    });

    it('drops points whose metric value is null instead of plotting a fake zero (the stray-0.0% fix)', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: DAY_MS, accuracyPct: null }), // all test cases errored
        makePoint({ timestamp: 2 * DAY_MS, accuracyPct: 80 }),
      ];
      const series = buildGapBrokenSeries(points, 'accuracy');
      expect(series.map(s => s.value)).toEqual([60, 80]); // the null-accuracy run never appears
    });

    it('never breaks a gap measured across a dropped null point using stale adjacency (gap is measured between the nearest PLOTTED points)', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: 3 * DAY_MS, accuracyPct: null }), // dropped, would have been "in between"
        makePoint({ timestamp: 5 * DAY_MS, accuracyPct: 80 }), // only 5 days from the last PLOTTED point
      ];
      const series = buildGapBrokenSeries(points, 'accuracy');
      expect(series.map(s => s.value)).toEqual([60, 80]); // no break: 5 days < 7-day threshold
    });

    it('returns [] for an agent with no plottable points for this metric', () => {
      const points = [makePoint({ timestamp: 0, costUsd: null })];
      expect(buildGapBrokenSeries(points, 'cost')).toEqual([]);
    });
  });

  describe('computeLatestDelta', () => {
    it('returns null delta with a single run (no prior run to compare)', () => {
      const points = [makePoint({ timestamp: 0, accuracyPct: 80 })];
      const delta = computeLatestDelta(points, 'accuracy');
      expect(delta).toEqual({ latestValue: 80, previousValue: null, delta: null });
    });

    it('computes latest-minus-previous for two runs (not week-over-week average)', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 60 }),
        makePoint({ timestamp: DAY_MS, accuracyPct: 80 }),
      ];
      expect(computeLatestDelta(points, 'accuracy')).toEqual({ latestValue: 80, previousValue: 60, delta: 20 });
    });

    it('uses the latest two runs that HAVE a value for the metric, skipping nulls in between', () => {
      const points = [
        makePoint({ timestamp: 0, costUsd: 1 }),
        makePoint({ timestamp: DAY_MS, costUsd: null }), // no trace match
        makePoint({ timestamp: 2 * DAY_MS, costUsd: 1.5 }),
      ];
      expect(computeLatestDelta(points, 'cost')).toEqual({ latestValue: 1.5, previousValue: 1, delta: 0.5 });
    });

    it('reports a negative delta for a regression', () => {
      const points = [
        makePoint({ timestamp: 0, accuracyPct: 90 }),
        makePoint({ timestamp: DAY_MS, accuracyPct: 70 }),
      ];
      expect(computeLatestDelta(points, 'accuracy').delta).toBe(-20);
    });

    it('returns all-null when there is no value at all for the metric', () => {
      const points = [makePoint({ timestamp: 0, costUsd: null })];
      expect(computeLatestDelta(points, 'cost')).toEqual({ latestValue: null, previousValue: null, delta: null });
    });
  });

  describe('formatDelta', () => {
    it('formats n/a for null', () => {
      expect(formatDelta('accuracy', null)).toBe('n/a');
    });
    it('formats a positive accuracy delta in percentage points with a + sign', () => {
      expect(formatDelta('accuracy', 3.2)).toBe('+3.2pp');
    });
    it('formats a negative accuracy delta without a double sign', () => {
      expect(formatDelta('accuracy', -4)).toBe('-4pp');
    });
    it('collapses a near-zero delta to a neutral ±0pp', () => {
      expect(formatDelta('accuracy', 0.01)).toBe('±0pp');
    });
    it('formats cost/token deltas via the metric formatter with a sign', () => {
      expect(formatDelta('cost', 0.5)).toMatch(/^\+.*\$/);
      expect(formatDelta('tokens', -200)).toMatch(/^-/);
    });
  });

  describe('buildAgentTrendRows', () => {
    it('builds one row per agent with runCount, latest run identity, series, and delta', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'a1', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
        makeRun({ id: 'a2', agentKey: 'agent-a', createdAt: '2024-06-05T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
        makeRun({ id: 'b1', agentKey: 'agent-b', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 7, failed: 3, pending: 0, total: 10 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const rows = buildAgentTrendRows(points, 'accuracy');
      expect(rows.map(r => r.agentKey).sort()).toEqual(['agent-a', 'agent-b']);

      const a = rows.find(r => r.agentKey === 'agent-a')!;
      expect(a.runCount).toBe(2);
      expect(a.latestRunDocId).toBe('a2');
      expect(a.latestValue).toBe(80);
      expect(a.previousValue).toBe(60);
      expect(a.delta).toBe(20);
      expect(a.series).toHaveLength(2);

      const b = rows.find(r => r.agentKey === 'agent-b')!;
      expect(b.runCount).toBe(1);
      expect(b.delta).toBeNull(); // single run: no prior run to diff against
    });

    it('a lone single run is a fully valid row (no >=2-points-across-all-agents floor, unlike the old chart)', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'only', agentKey: 'agent-a', stats: { passed: 5, failed: 5, pending: 0, total: 10 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const rows = buildAgentTrendRows(points, 'accuracy');
      expect(rows).toHaveLength(1);
      expect(rows[0].latestValue).toBe(50);
    });

    it('returns [] for an empty point set', () => {
      expect(buildAgentTrendRows([], 'accuracy')).toEqual([]);
    });
  });

  describe('sortAgentTrendRows', () => {
    const bm = makeBenchmark('bm-1', 'B', [
      // agent-hi: latest 90%, up from 70% (+20)
      makeRun({ id: 'hi-1', agentKey: 'agent-hi', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 7, failed: 3, pending: 0, total: 10 } }),
      makeRun({ id: 'hi-2', agentKey: 'agent-hi', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 9, failed: 1, pending: 0, total: 10 } }),
      // agent-lo: latest 30%, down from 80% (-50, biggest drop)
      makeRun({ id: 'lo-1', agentKey: 'agent-lo', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
      makeRun({ id: 'lo-2', agentKey: 'agent-lo', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 3, failed: 7, pending: 0, total: 10 } }),
      // agent-new: single run, 60%, no delta signal
      makeRun({ id: 'new-1', agentKey: 'agent-new', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
    ]);
    const points = buildAgentRunPoints([bm], [], new Map());
    const rows = buildAgentTrendRows(points, 'accuracy');

    it('"latest" sorts by current value descending, undefined-value rows last', () => {
      const sorted = sortAgentTrendRows(rows, 'latest');
      expect(sorted.map(r => r.agentKey)).toEqual(['agent-hi', 'agent-new', 'agent-lo']);
    });

    it('"biggestDrop" sorts by delta ascending (most negative first), no-delta rows last', () => {
      const sorted = sortAgentTrendRows(rows, 'biggestDrop');
      expect(sorted.map(r => r.agentKey)).toEqual(['agent-lo', 'agent-hi', 'agent-new']);
    });

    it('does not mutate the input array', () => {
      const before = rows.map(r => r.agentKey);
      sortAgentTrendRows(rows, 'biggestDrop');
      expect(rows.map(r => r.agentKey)).toEqual(before);
    });
  });

  describe('getMostRecentlyActiveBenchmarkId', () => {
    it('picks the benchmark whose most recent run is newest', () => {
      const bmA = makeBenchmark('bm-a', 'A', [makeRun({ id: 'a1', createdAt: '2024-01-01T00:00:00Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } })]);
      const bmB = makeBenchmark('bm-b', 'B', [makeRun({ id: 'b1', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } })]);
      expect(getMostRecentlyActiveBenchmarkId([bmA, bmB])).toBe('bm-b');
    });

    it('returns null when there are no benchmarks or no runs', () => {
      expect(getMostRecentlyActiveBenchmarkId([])).toBeNull();
      expect(getMostRecentlyActiveBenchmarkId([makeBenchmark('bm-1', 'B', [])])).toBeNull();
    });
  });

  describe('buildBenchmarkDotPlotRows (ranked dot plot — v3 primary viz)', () => {
    it('splits each agent\'s valued runs into latest (most recent) + history (earlier), excluding latest from history', () => {
      const points = [
        makePoint({ agentKey: 'agent-a', timestamp: 0, accuracyPct: 60 }),
        makePoint({ agentKey: 'agent-a', timestamp: DAY_MS, accuracyPct: 70 }),
        makePoint({ agentKey: 'agent-a', timestamp: 2 * DAY_MS, accuracyPct: 90 }),
      ];
      const [row] = buildBenchmarkDotPlotRows(points, 'accuracy');
      expect(row.latest?.value).toBe(90);
      expect(row.history.map(h => h.value)).toEqual([60, 70]);
    });

    it('one row per agent scoped to whatever points are passed in (caller is responsible for the single-benchmark scope)', () => {
      const points = [
        makePoint({ agentKey: 'agent-a', agentName: 'Agent A', timestamp: 0, accuracyPct: 80 }),
        makePoint({ agentKey: 'agent-b', agentName: 'Agent B', timestamp: 0, accuracyPct: 50 }),
      ];
      const rows = buildBenchmarkDotPlotRows(points, 'accuracy');
      expect(rows.map(r => r.agentKey).sort()).toEqual(['agent-a', 'agent-b']);
    });

    it('still returns a row (latest: null) for an agent with no resolved value for the current metric', () => {
      const points = [makePoint({ agentKey: 'agent-a', timestamp: 0, costUsd: null })];
      const [row] = buildBenchmarkDotPlotRows(points, 'cost');
      expect(row.latest).toBeNull();
      expect(row.history).toEqual([]);
    });

    it('drops metric-null points from both latest and history (the stray-0.0% fix applies here too)', () => {
      const points = [
        makePoint({ agentKey: 'agent-a', timestamp: 0, accuracyPct: 60 }),
        makePoint({ agentKey: 'agent-a', timestamp: DAY_MS, accuracyPct: null }), // all test cases errored
        makePoint({ agentKey: 'agent-a', timestamp: 2 * DAY_MS, accuracyPct: 80 }),
      ];
      const [row] = buildBenchmarkDotPlotRows(points, 'accuracy');
      expect(row.latest?.value).toBe(80);
      expect(row.history.map(h => h.value)).toEqual([60]);
    });

    it('returns [] for an empty point set', () => {
      expect(buildBenchmarkDotPlotRows([], 'accuracy')).toEqual([]);
    });
  });

  describe('rankDotPlotRows', () => {
    it('ranks by latest value descending — best (highest) on top — and stamps 0-based rank', () => {
      const points = [
        makePoint({ agentKey: 'agent-mid', agentName: 'Mid', timestamp: 0, accuracyPct: 70 }),
        makePoint({ agentKey: 'agent-best', agentName: 'Best', timestamp: 0, accuracyPct: 95 }),
        makePoint({ agentKey: 'agent-worst', agentName: 'Worst', timestamp: 0, accuracyPct: 40 }),
      ];
      const rows = buildBenchmarkDotPlotRows(points, 'accuracy');
      const ranked = rankDotPlotRows(rows);
      expect(ranked.map(r => r.agentKey)).toEqual(['agent-best', 'agent-mid', 'agent-worst']);
      expect(ranked.map(r => r.rank)).toEqual([0, 1, 2]);
    });

    it('sorts rows with no value for the metric last, ordered by name among themselves', () => {
      const points = [
        makePoint({ agentKey: 'agent-has-cost', agentName: 'HasCost', timestamp: 0, costUsd: 1.2 }),
        makePoint({ agentKey: 'agent-zeta-no-cost', agentName: 'ZetaNoCost', timestamp: 0, costUsd: null }),
        makePoint({ agentKey: 'agent-alpha-no-cost', agentName: 'AlphaNoCost', timestamp: 0, costUsd: null }),
      ];
      const ranked = rankDotPlotRows(buildBenchmarkDotPlotRows(points, 'cost'));
      expect(ranked.map(r => r.agentKey)).toEqual(['agent-has-cost', 'agent-alpha-no-cost', 'agent-zeta-no-cost']);
    });

    it('does not mutate the input array', () => {
      const points = [
        makePoint({ agentKey: 'a', timestamp: 0, accuracyPct: 50 }),
        makePoint({ agentKey: 'b', timestamp: 0, accuracyPct: 90 }),
      ];
      const rows = buildBenchmarkDotPlotRows(points, 'accuracy');
      const before = rows.map(r => r.agentKey);
      rankDotPlotRows(rows);
      expect(rows.map(r => r.agentKey)).toEqual(before);
    });
  });

  describe('metricDomain', () => {
    it('anchors accuracy to the true [0, 100] scale regardless of the observed value range', () => {
      const points = [makePoint({ agentKey: 'a', timestamp: 0, accuracyPct: 91 }), makePoint({ agentKey: 'b', timestamp: 0, accuracyPct: 93 })];
      expect(metricDomain(buildBenchmarkDotPlotRows(points, 'accuracy'), 'accuracy')).toEqual([0, 100]);
    });

    it('anchors cost/tokens at 0 with headroom above the observed max', () => {
      const points = [makePoint({ agentKey: 'a', timestamp: 0, costUsd: 2 }), makePoint({ agentKey: 'b', timestamp: 0, costUsd: 5 })];
      const domain = metricDomain(buildBenchmarkDotPlotRows(points, 'cost'), 'cost');
      expect(domain![0]).toBe(0);
      expect(domain![1]).toBeGreaterThan(5);
    });

    it('returns null when there is nothing to plot', () => {
      expect(metricDomain([], 'accuracy')).toBeNull();
      const points = [makePoint({ agentKey: 'a', timestamp: 0, costUsd: null })];
      expect(metricDomain(buildBenchmarkDotPlotRows(points, 'cost'), 'cost')).toBeNull();
    });
  });

  describe('valueToPercent', () => {
    it('maps the domain min/max to 0/100 and the midpoint to 50', () => {
      expect(valueToPercent(0, [0, 100])).toBe(0);
      expect(valueToPercent(100, [0, 100])).toBe(100);
      expect(valueToPercent(50, [0, 100])).toBe(50);
    });

    it('clamps out-of-domain values into [0, 100]', () => {
      expect(valueToPercent(-10, [0, 100])).toBe(0);
      expect(valueToPercent(150, [0, 100])).toBe(100);
    });

    it('returns 50 for a degenerate zero-width domain instead of dividing by zero', () => {
      expect(valueToPercent(5, [5, 5])).toBe(50);
    });
  });
});
