/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildAgentRunPoints,
  buildAgentColorMap,
  computeAgentChipSummaries,
  getMostRecentlyActiveBenchmarkId,
  getRunAccuracy,
  groupPointsByAgent,
  metricValue,
  rollingAverage,
  timeRangeToSinceMs,
  type RunMetricsLookup,
} from '@/lib/agentTrends';
import type { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';

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

    it('returns 0% (not NaN) for a run with zero evaluable test cases', () => {
      const run = makeRun({ stats: { passed: 0, failed: 0, pending: 0, errored: 2, total: 2 } });
      expect(getRunAccuracy(run).accuracyPct).toBe(0);
    });
  });

  describe('timeRangeToSinceMs', () => {
    const now = new Date('2024-06-30T00:00:00.000Z').getTime();
    it('computes 7d/30d/90d cutoffs relative to now', () => {
      expect(timeRangeToSinceMs('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
      expect(timeRangeToSinceMs('30d', now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
      expect(timeRangeToSinceMs('90d', now)).toBe(now - 90 * 24 * 60 * 60 * 1000);
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

  describe('rollingAverage', () => {
    it('returns [] for an empty series', () => {
      expect(rollingAverage([])).toEqual([]);
    });

    it('averages a single point to itself', () => {
      expect(rollingAverage([10])).toEqual([10]);
    });

    it('computes a trailing window average matching window=3', () => {
      expect(rollingAverage([10, 20, 30, 40], 3)).toEqual([10, 15, 20, 30]);
    });

    it('with window=1 the rolling average equals the raw series', () => {
      expect(rollingAverage([5, 8, 2], 1)).toEqual([5, 8, 2]);
    });

    it('skips nulls without polluting the average, and reports null until data appears', () => {
      expect(rollingAverage([null, null, 10, null, 20], 2)).toEqual([null, null, 10, 10, 15]);
    });

    it('treats window<=0 as window=1', () => {
      expect(rollingAverage([1, 2, 3], 0)).toEqual([1, 2, 3]);
    });
  });

  describe('metricValue', () => {
    const point = {
      runDocId: 'r', benchmarkId: 'b', benchmarkName: 'B', agentKey: 'a', agentName: 'A',
      modelId: 'm', createdAt: '2024-01-01T00:00:00Z', timestamp: 0,
      passed: 1, failed: 0, total: 1, accuracyPct: 100, costUsd: 1.5, tokens: 100,
    };
    it('reads the right field per metric key', () => {
      expect(metricValue(point, 'accuracy')).toBe(100);
      expect(metricValue(point, 'cost')).toBe(1.5);
      expect(metricValue(point, 'tokens')).toBe(100);
    });
  });

  describe('computeAgentChipSummaries', () => {
    const now = new Date('2024-06-30T00:00:00.000Z').getTime();

    it('returns null wowDelta with a single run (no prior-week baseline)', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-06-29T00:00:00.000Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const [summary] = computeAgentChipSummaries(points, now);
      expect(summary.latestAccuracyPct).toBe(80);
      expect(summary.wowDeltaPct).toBeNull();
      expect(summary.runCount).toBe(1);
    });

    it('computes a positive week-over-week delta from two full weeks of runs', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        // prior week (8-14 days ago): 60% avg
        makeRun({ id: 'prev-1', agentKey: 'a', createdAt: '2024-06-17T00:00:00.000Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
        // this week (last 7 days): 80% avg
        makeRun({ id: 'cur-1', agentKey: 'a', createdAt: '2024-06-29T00:00:00.000Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const [summary] = computeAgentChipSummaries(points, now);
      expect(summary.wowDeltaPct).toBeCloseTo(20, 5);
      expect(summary.latestAccuracyPct).toBe(80);
    });

    it('handles multiple agents and sorts by most-recently-active first', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'r-old', agentKey: 'agent-old', createdAt: '2024-06-01T00:00:00.000Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
        makeRun({ id: 'r-new', agentKey: 'agent-new', createdAt: '2024-06-29T00:00:00.000Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
      ]);
      const points = buildAgentRunPoints([bm], [], new Map());
      const summaries = computeAgentChipSummaries(points, now);
      expect(summaries.map(s => s.agentKey)).toEqual(['agent-new', 'agent-old']);
    });

    it('returns [] for an empty point set (no benchmarks/runs)', () => {
      expect(computeAgentChipSummaries([], now)).toEqual([]);
    });

    it('carries the latest run cost/tokens through to the chip', () => {
      const bm = makeBenchmark('bm-1', 'B', [
        makeRun({ id: 'r1', agentKey: 'a', createdAt: '2024-06-29T00:00:00.000Z', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
      ]);
      const reports = [makeReport({ id: 'rep-1', experimentRunId: 'r1', runId: 'agent-run-1' })];
      const metricsMap = new Map<string, RunMetricsLookup>([['agent-run-1', { costUsd: 2.5, tokens: 4200 }]]);
      const points = buildAgentRunPoints([bm], reports, metricsMap);
      const [summary] = computeAgentChipSummaries(points, now);
      expect(summary.latestCostUsd).toBeCloseTo(2.5, 6);
      expect(summary.latestTokens).toBe(4200);
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

  describe('buildAgentColorMap', () => {
    it('assigns distinct colors deterministically by sorted agent key', () => {
      const map = buildAgentColorMap(['agent-b', 'agent-a', 'agent-a']);
      expect(map.size).toBe(2);
      expect(map.get('agent-a')).not.toBe(map.get('agent-b'));
      // Re-running with the same (even differently ordered/duplicated) input is stable.
      const map2 = buildAgentColorMap(['agent-a', 'agent-b']);
      expect(map2.get('agent-a')).toBe(map.get('agent-a'));
      expect(map2.get('agent-b')).toBe(map.get('agent-b'));
    });
  });
});
