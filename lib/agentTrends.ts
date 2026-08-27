/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trends Band — Aggregation Utilities
 *
 * Builds the per-run, per-agent data model behind the landing-page
 * "Agent trends" band: chip summaries (latest accuracy + week-over-week
 * delta + cost/tokens per run) and the multi-agent trend chart (one dot
 * per BenchmarkRun, plus a rolling-average line per agent).
 *
 * Deliberately kept UI-framework-free so it's cheaply unit testable and
 * so it can be reused by both the chart component and the chip row.
 *
 * Data-source note: accuracy/pass counts come straight from
 * `Benchmark.runs[]` (already loaded by the Dashboard for the runs list —
 * no extra fetch). Cost/tokens are trace-derived and only available for
 * runs whose reports were resolved in the caller's `metricsMap` (see
 * services/metrics.ts#fetchBatchMetrics); a run reports `costUsd`/`tokens`
 * only when EVERY one of its reports resolved a match — a partial sum
 * would understate the run's true cost while looking complete, which is
 * worse than admitting "unknown" — so partially- or fully-unmatched runs
 * get `null` rather than a fabricated or partial total, and callers render
 * an honest "—" instead.
 */

import type { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';
import { bucketRunResults } from '@/lib/runStats';

export type TrendMetricKey = 'accuracy' | 'cost' | 'tokens';

export type TrendsTimeRange = '7d' | '30d' | '90d';

export interface RunMetricsLookup {
  costUsd: number;
  tokens: number;
}

/** One dot on the trend chart: a single BenchmarkRun for one agent. */
export interface AgentRunPoint {
  runDocId: string; // BenchmarkRun.id
  benchmarkId: string;
  benchmarkName: string;
  agentKey: string;
  agentName: string;
  modelId: string;
  createdAt: string; // ISO
  timestamp: number; // epoch ms (convenience for sorting / charting)
  passed: number;
  failed: number;
  total: number;
  accuracyPct: number; // 0-100, over the evaluable set
  costUsd: number | null; // null = no trace metrics resolved for this run
  tokens: number | null;
}

export interface AgentChipSummary {
  agentKey: string;
  agentName: string;
  latestAccuracyPct: number | null;
  wowDeltaPct: number | null; // null when there isn't a full prior week to compare
  latestCostUsd: number | null;
  latestTokens: number | null;
  latestRunAt: string | null;
  latestRunDocId: string | null;
  latestBenchmarkId: string | null;
  runCount: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deterministic, visually distinct color palette for the chart lines / chip
 * left-borders. Assigned by sorted agentKey so colors stay stable across
 * re-renders and time-range/benchmark filtering (not by first-seen order,
 * which would shuffle as the visible run set changes).
 */
const AGENT_PALETTE = [
  '#7fb5ff', '#37d67a', '#f5b759', '#ff6b6b',
  '#b98cf0', '#4dd0e1', '#f472b6', '#a3e635',
  '#fb923c', '#60a5fa',
];

export function buildAgentColorMap(agentKeys: string[]): Map<string, string> {
  const sorted = [...new Set(agentKeys)].sort();
  const map = new Map<string, string>();
  sorted.forEach((key, i) => map.set(key, AGENT_PALETTE[i % AGENT_PALETTE.length]));
  return map;
}

/**
 * Compute passed/failed/total/accuracyPct for a run, preferring the
 * denormalized `run.stats` (fast path) and falling back to bucketing
 * `run.results` directly (same canonical logic used by the runs list) —
 * no report fetch required either way.
 */
export function getRunAccuracy(run: BenchmarkRun): {
  passed: number;
  failed: number;
  total: number;
  accuracyPct: number;
} {
  if (run.stats && run.stats.total > 0) {
    const evaluable = Math.max(0, run.stats.total - (run.stats.errored || 0));
    const accuracyPct = evaluable > 0 ? (run.stats.passed / evaluable) * 100 : 0;
    return { passed: run.stats.passed, failed: run.stats.failed, total: run.stats.total, accuracyPct };
  }
  const bucketed = bucketRunResults(run.results);
  const evaluable = Math.max(0, bucketed.total - bucketed.errored);
  const accuracyPct = evaluable > 0 ? (bucketed.passed / evaluable) * 100 : 0;
  return { passed: bucketed.passed, failed: bucketed.failed, total: bucketed.total, accuracyPct };
}

export function timeRangeToSinceMs(range: TrendsTimeRange, nowMs: number = Date.now()): number {
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

export interface BuildAgentRunPointsOptions {
  benchmarkId?: string | null;
  sinceMs?: number | null;
  agentDisplayName?: (agentKey: string) => string;
}

/**
 * Build one AgentRunPoint per BenchmarkRun (skipping runs with zero test
 * cases — e.g. still-provisioning or cancelled-before-start runs), sorted
 * ascending by time.
 */
export function buildAgentRunPoints(
  benchmarks: Benchmark[],
  reports: EvaluationReport[],
  metricsMap: Map<string, RunMetricsLookup>,
  options: BuildAgentRunPointsOptions = {},
): AgentRunPoint[] {
  const displayName = options.agentDisplayName ?? ((key: string) => key);

  // Pre-index reports by the BenchmarkRun id they belong to
  // (EvaluationReport.experimentRunId === BenchmarkRun.id).
  const reportsByRunDocId = new Map<string, EvaluationReport[]>();
  for (const report of reports) {
    if (!report.experimentRunId) continue;
    const existing = reportsByRunDocId.get(report.experimentRunId);
    if (existing) existing.push(report);
    else reportsByRunDocId.set(report.experimentRunId, [report]);
  }

  const points: AgentRunPoint[] = [];

  for (const benchmark of benchmarks) {
    if (options.benchmarkId && benchmark.id !== options.benchmarkId) continue;

    for (const run of benchmark.runs || []) {
      const timestamp = new Date(run.createdAt).getTime();
      if (Number.isNaN(timestamp)) continue;
      if (options.sinceMs != null && timestamp < options.sinceMs) continue;

      const { passed, failed, total, accuracyPct } = getRunAccuracy(run);
      if (total === 0) continue; // nothing to plot for an empty run

      const runReports = reportsByRunDocId.get(run.id) || [];
      let matched = 0;
      let costSum = 0;
      let tokenSum = 0;
      for (const report of runReports) {
        const lookup = report.runId ? metricsMap.get(report.runId) : undefined;
        if (!lookup) continue;
        costSum += lookup.costUsd;
        tokenSum += lookup.tokens;
        matched++;
      }
      // Only expose a run-level cost/token total when EVERY report for this
      // run resolved trace metrics. A partial sum (some test cases matched,
      // some didn't) would silently understate the run's true cost/tokens
      // while looking like a complete total — worse than admitting "unknown".
      const isComplete = runReports.length > 0 && matched === runReports.length;

      points.push({
        runDocId: run.id,
        benchmarkId: benchmark.id,
        benchmarkName: benchmark.name,
        agentKey: run.agentKey || 'unknown',
        agentName: displayName(run.agentKey || 'unknown'),
        modelId: run.modelId || '',
        createdAt: run.createdAt,
        timestamp,
        passed,
        failed,
        total,
        accuracyPct,
        costUsd: isComplete ? costSum : null,
        tokens: isComplete ? tokenSum : null,
      });
    }
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

/** Group already time-sorted points by agentKey, preserving relative order. */
export function groupPointsByAgent(points: AgentRunPoint[]): Map<string, AgentRunPoint[]> {
  const map = new Map<string, AgentRunPoint[]>();
  for (const point of points) {
    const existing = map.get(point.agentKey);
    if (existing) existing.push(point);
    else map.set(point.agentKey, [point]);
  }
  return map;
}

/**
 * Trailing rolling average over a metric series, skipping `null` samples
 * (e.g. runs with no trace-derived cost/tokens). Returns `null` for any
 * position with no non-null samples yet in the window — callers can treat
 * `null` as "don't plot this point on the average line".
 */
export function rollingAverage(values: Array<number | null>, window: number = 3): Array<number | null> {
  if (window <= 0) window = 1;
  const out: Array<number | null> = [];
  const buffer: number[] = [];
  for (const value of values) {
    if (value != null && !Number.isNaN(value)) {
      buffer.push(value);
      if (buffer.length > window) buffer.shift();
    }
    out.push(buffer.length > 0 ? buffer.reduce((a, b) => a + b, 0) / buffer.length : null);
  }
  return out;
}

export function metricValue(point: AgentRunPoint, metric: TrendMetricKey): number | null {
  switch (metric) {
    case 'accuracy':
      return point.accuracyPct;
    case 'cost':
      return point.costUsd;
    case 'tokens':
      return point.tokens;
    default:
      return null;
  }
}

/** One plottable dot for the trend chart's scatter series. */
export interface AgentSeriesPoint {
  point: AgentRunPoint;
  value: number;
  /**
   * True for the last (most recent) plotted point of this agent's series.
   * The chart always pins a "name: value" label on this point regardless
   * of label-overlap decluttering, per the approved design.
   */
  isLatest: boolean;
}

/** One agent's line (rolling average) + dots (individual runs) for the trend chart. */
export interface AgentSeriesData {
  agentKey: string;
  agentName: string;
  /** Rolling-average line, [timestamp, value] pairs, gaps (nulls) omitted. */
  lineData: Array<[number, number]>;
  scatterData: AgentSeriesPoint[];
}

/**
 * Group `points` by agent and shape them into per-agent line/scatter series
 * data for the trend chart, honoring per-agent visibility (the agents
 * drawer's checkboxes) by omitting hidden agents entirely — this is the
 * shared, framework-free logic that decides what the chart draws, kept
 * separate from AgentTrendsEChart's echarts-specific option wiring so it's
 * cheaply unit testable.
 */
export function buildAgentTrendSeries(
  points: AgentRunPoint[],
  metric: TrendMetricKey,
  hiddenAgentKeys: ReadonlySet<string> = new Set(),
  rollingWindow: number = 3,
): AgentSeriesData[] {
  const grouped = groupPointsByAgent(points);
  const out: AgentSeriesData[] = [];

  for (const [agentKey, agentPoints] of grouped) {
    if (hiddenAgentKeys.has(agentKey)) continue;

    const rawValues = agentPoints.map(p => metricValue(p, metric));
    const rolling = rollingAverage(rawValues, rollingWindow);
    const lineData = agentPoints
      .map((p, i) => (rolling[i] != null ? ([p.timestamp, rolling[i] as number] as [number, number]) : null))
      .filter((d): d is [number, number] => d != null);

    const valued = agentPoints
      .map((p, i) => ({ p, v: rawValues[i] }))
      .filter((d): d is { p: AgentRunPoint; v: number } => d.v != null);
    const lastValuedIndex = valued.length - 1;

    const scatterData: AgentSeriesPoint[] = valued.map(({ p, v }, i) => ({
      point: p,
      value: v,
      isLatest: i === lastValuedIndex,
    }));

    out.push({ agentKey, agentName: agentPoints[0].agentName, lineData, scatterData });
  }

  return out;
}

/**
 * Per-agent chip summary: latest accuracy + week-over-week delta (avg
 * accuracy of runs in the trailing 7 days vs the 7 days before that) +
 * latest run's cost/tokens.
 *
 * `wowDeltaPct` is `null` whenever either window has zero runs — a single
 * run, or a burst of runs that's all newer than 7 days old, can't produce a
 * meaningful week-over-week comparison, so we say so rather than fabricate
 * a delta against nothing.
 */
export function computeAgentChipSummaries(
  points: AgentRunPoint[],
  nowMs: number = Date.now(),
): AgentChipSummary[] {
  const byAgent = groupPointsByAgent(points);
  const summaries: AgentChipSummary[] = [];

  for (const [agentKey, agentPoints] of byAgent) {
    if (agentPoints.length === 0) continue;
    const latest = agentPoints[agentPoints.length - 1];

    const thisWeek = agentPoints.filter(p => p.timestamp > nowMs - WEEK_MS);
    const prevWeek = agentPoints.filter(
      p => p.timestamp <= nowMs - WEEK_MS && p.timestamp > nowMs - 2 * WEEK_MS,
    );
    const avgAccuracy = (arr: AgentRunPoint[]): number | null =>
      arr.length > 0 ? arr.reduce((sum, p) => sum + p.accuracyPct, 0) / arr.length : null;

    const thisWeekAvg = avgAccuracy(thisWeek);
    const prevWeekAvg = avgAccuracy(prevWeek);
    const wowDeltaPct = thisWeekAvg != null && prevWeekAvg != null ? thisWeekAvg - prevWeekAvg : null;

    summaries.push({
      agentKey,
      agentName: latest.agentName,
      latestAccuracyPct: latest.accuracyPct,
      wowDeltaPct,
      latestCostUsd: latest.costUsd,
      latestTokens: latest.tokens,
      latestRunAt: latest.createdAt,
      latestRunDocId: latest.runDocId,
      latestBenchmarkId: latest.benchmarkId,
      runCount: agentPoints.length,
    });
  }

  // Most recently active agent first.
  summaries.sort((a, b) => new Date(b.latestRunAt || 0).getTime() - new Date(a.latestRunAt || 0).getTime());
  return summaries;
}

/** Default benchmark selector value: the benchmark with the most recent run. */
export function getMostRecentlyActiveBenchmarkId(benchmarks: Benchmark[]): string | null {
  let bestId: string | null = null;
  let bestTimestamp = -Infinity;
  for (const benchmark of benchmarks) {
    for (const run of benchmark.runs || []) {
      const ts = new Date(run.createdAt).getTime();
      if (!Number.isNaN(ts) && ts > bestTimestamp) {
        bestTimestamp = ts;
        bestId = benchmark.id;
      }
    }
  }
  return bestId;
}
