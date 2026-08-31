/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trends Band — Aggregation Utilities
 *
 * Builds the per-run, per-agent data model behind the landing-page
 * "Agent trends" band: v3 replaces the all-agents overlay chart (one
 * ECharts line+scatter series per agent, sharing a 10-color palette) with
 * a small-multiples sparkline-table — one row per agent, sorted by latest
 * score or biggest drop, each row's sparkline + a single-agent focused
 * detail chart built from the SAME gap-broken series shape.
 *
 * Deliberately kept UI-framework-free so it's cheaply unit testable and
 * so it can be reused by the row list, the drawer, and the detail chart.
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
import { formatCost, formatTokens } from '@/services/metrics';

export type TrendMetricKey = 'accuracy' | 'cost' | 'tokens';

export type TrendsTimeRange = '7d' | '30d' | '90d';

export type TrendSortMode = 'latest' | 'biggestDrop';

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
  /**
   * 0-100 pass rate over the evaluable set, or `null` when the run had
   * ZERO evaluable test cases (every case errored — no judge verdict at
   * all). Owner-reported bug: this used to default to `0`, which is
   * visually indistinguishable from a genuine "the agent passed nothing"
   * result — a run with no signal must never render as a real data point.
   */
  accuracyPct: number | null;
  costUsd: number | null; // null = no trace metrics resolved for this run
  tokens: number | null;
}

const GAP_BREAK_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Deterministic, visually distinct color palette for the chart lines / chip
 * left-borders. Assigned by sorted agentKey so colors stay stable across
 * re-renders and time-range/benchmark filtering (not by first-seen order,
 * which would shuffle as the visible run set changes).
 *
 * v3 note: the small-multiples redesign no longer overlays every agent's
 * line on one chart, so per-agent hue no longer needs to scale to N agents
 * (the old 10-color palette repeated after the 10th agent — "indistinguishable
 * colors" in the owner's feedback with 14 agents in scope). Each row/detail
 * chart is already labeled by name, so a single, theme-aware accent color
 * plus semantic (up/down) delta coloring is used everywhere instead — see
 * `TREND_LINE_COLOR` in AgentTrendSparkline/AgentTrendDetailChart.
 */

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
  accuracyPct: number | null;
} {
  if (run.stats && run.stats.total > 0) {
    const evaluable = Math.max(0, run.stats.total - (run.stats.errored || 0));
    const accuracyPct = evaluable > 0 ? (run.stats.passed / evaluable) * 100 : null;
    return { passed: run.stats.passed, failed: run.stats.failed, total: run.stats.total, accuracyPct };
  }
  const bucketed = bucketRunResults(run.results);
  const evaluable = Math.max(0, bucketed.total - bucketed.errored);
  const accuracyPct = evaluable > 0 ? (bucketed.passed / evaluable) * 100 : null;
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

export function formatMetricValue(metric: TrendMetricKey, value: number): string {
  switch (metric) {
    case 'accuracy':
      return `${value.toFixed(1)}%`;
    case 'cost':
      return formatCost(value);
    case 'tokens':
      return formatTokens(value);
    default:
      return String(value);
  }
}

/** One entry in a gap-broken trend series. `value: null` marks a synthetic break, never a real run. */
export interface TrendSeriesEntry {
  timestamp: number;
  value: number | null;
  point: AgentRunPoint | null;
}

/**
 * Build one agent's gap-broken series for `metric`: points whose metric
 * value is null (no evaluable accuracy, or no trace-resolved cost/tokens)
 * are dropped — never plotted as a fake zero. A synthetic `{ value: null }`
 * marker is inserted at the midpoint between any two consecutive PLOTTED
 * points whose time gap exceeds `gapBreakMs` (default 7 days).
 *
 * Why: a chart line drawn between two data-array entries connects them
 * with a straight (or smoothed) segment regardless of how far apart their
 * x-values are — so two runs 25 days apart look, visually, like a
 * continuous trend across those 25 days ("sparse runs produce misleading
 * long interpolated lines" — owner feedback). Inserting a null-valued
 * entry between them gives recharts' `<Line connectNulls={false}>` (the
 * default) an explicit place to break the path, while the surrounding
 * dead space still renders proportionally on a time-scaled x-axis.
 */
export function buildGapBrokenSeries(
  agentPoints: AgentRunPoint[], // already time-sorted, single agent
  metric: TrendMetricKey,
  gapBreakMs: number = GAP_BREAK_MS_DEFAULT,
): TrendSeriesEntry[] {
  const valued = agentPoints
    .map(p => ({ p, v: metricValue(p, metric) }))
    .filter((d): d is { p: AgentRunPoint; v: number } => d.v != null);

  const out: TrendSeriesEntry[] = [];
  for (let i = 0; i < valued.length; i++) {
    const { p, v } = valued[i];
    if (i > 0) {
      const prev = valued[i - 1].p;
      if (p.timestamp - prev.timestamp > gapBreakMs) {
        out.push({ timestamp: (prev.timestamp + p.timestamp) / 2, value: null, point: null });
      }
    }
    out.push({ timestamp: p.timestamp, value: v, point: p });
  }
  return out;
}

/** Latest-vs-previous delta for one agent's metric series (not week-over-week — the immediately prior run). */
export interface TrendDelta {
  latestValue: number | null;
  previousValue: number | null;
  /** latestValue - previousValue; null unless BOTH resolved to a real value. */
  delta: number | null;
}

export function computeLatestDelta(agentPoints: AgentRunPoint[], metric: TrendMetricKey): TrendDelta {
  const validValues = agentPoints
    .map(p => metricValue(p, metric))
    .filter((v): v is number => v != null);
  const n = validValues.length;
  const latestValue = n >= 1 ? validValues[n - 1] : null;
  const previousValue = n >= 2 ? validValues[n - 2] : null;
  const delta = latestValue != null && previousValue != null ? latestValue - previousValue : null;
  return { latestValue, previousValue, delta };
}

export function formatDelta(metric: TrendMetricKey, delta: number | null): string {
  if (delta == null) return 'n/a';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
  if (metric === 'accuracy') {
    const rounded = Math.round(delta * 10) / 10;
    if (Math.abs(rounded) < 0.05) return '±0pp';
    return `${rounded > 0 ? '+' : ''}${rounded}pp`;
  }
  return `${sign}${formatMetricValue(metric, Math.abs(delta))}`;
}

/** One row in the sparkline-table: one agent, its gap-broken series for the current metric, latest value + delta. */
export interface AgentTrendRow {
  agentKey: string;
  agentName: string;
  runCount: number;
  latestRunAt: string | null;
  latestRunDocId: string | null;
  latestBenchmarkId: string | null;
  /** All of this agent's points, time-sorted (unfiltered by metric) — the detail chart re-derives per-metric series from this on focus. */
  points: AgentRunPoint[];
  /** Gap-broken series for the CURRENTLY selected metric — what the row's sparkline draws. */
  series: TrendSeriesEntry[];
  latestValue: number | null;
  previousValue: number | null;
  delta: number | null;
}

/**
 * Group `points` by agent and shape each into a sparkline-table row for
 * the given metric. One row per agent that has at least one point in
 * scope — a single run is a perfectly valid row (a lone dot, `delta: null`
 * rendered as "n/a"); there is no "not enough data" floor at the row
 * level (unlike the old all-agents chart, which needed >=2 points across
 * ALL agents just to avoid an empty canvas).
 */
export function buildAgentTrendRows(
  points: AgentRunPoint[],
  metric: TrendMetricKey,
  gapBreakMs: number = GAP_BREAK_MS_DEFAULT,
): AgentTrendRow[] {
  const grouped = groupPointsByAgent(points);
  const rows: AgentTrendRow[] = [];
  for (const [agentKey, agentPoints] of grouped) {
    if (agentPoints.length === 0) continue;
    const latest = agentPoints[agentPoints.length - 1];
    const { latestValue, previousValue, delta } = computeLatestDelta(agentPoints, metric);
    rows.push({
      agentKey,
      agentName: latest.agentName,
      runCount: agentPoints.length,
      latestRunAt: latest.createdAt,
      latestRunDocId: latest.runDocId,
      latestBenchmarkId: latest.benchmarkId,
      points: agentPoints,
      series: buildGapBrokenSeries(agentPoints, metric, gapBreakMs),
      latestValue,
      previousValue,
      delta,
    });
  }
  return rows;
}

/**
 * Sort rows by latest value (highest first; rows with no value for the
 * current metric sort last) or by biggest drop (most negative delta
 * first; rows with no delta sort last, ordered among themselves by latest
 * value so a still-informative "no signal yet" row isn't buried below a
 * literal `undefined`-sorts-arbitrarily bucket).
 */
export function sortAgentTrendRows(rows: AgentTrendRow[], sortMode: TrendSortMode): AgentTrendRow[] {
  const sorted = [...rows];
  if (sortMode === 'biggestDrop') {
    sorted.sort((a, b) => {
      if (a.delta == null && b.delta == null) return (b.latestValue ?? -Infinity) - (a.latestValue ?? -Infinity);
      if (a.delta == null) return 1;
      if (b.delta == null) return -1;
      return a.delta - b.delta; // ascending: most negative (biggest drop) first
    });
  } else {
    sorted.sort((a, b) => {
      if (a.latestValue == null && b.latestValue == null) return 0;
      if (a.latestValue == null) return 1;
      if (b.latestValue == null) return -1;
      return b.latestValue - a.latestValue; // descending: highest first
    });
  }
  return sorted;
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

// ==================== Ranked dot plot (primary v3 viz) ====================
//
// A Cleveland-style ranked dot plot of ONE benchmark's latest snapshot:
// one row per agent that ran it, ranked by latest score; a large solid dot
// for the latest run and small faded dots for that agent's earlier runs on
// the SAME benchmark (variance/history at a glance, no interpolated lines
// across time — there IS no time axis here, just "latest" vs "earlier").
// Callers scope `points` to a single benchmarkId before calling these.

/** One plottable dot: a run + its resolved metric value (metric-null points are never included). */
export interface DotPlotEntry {
  point: AgentRunPoint;
  value: number;
}

/** One row of the ranked dot plot: one agent, its latest dot (solid) + earlier dots (faded). */
export interface BenchmarkDotPlotRow {
  agentKey: string;
  agentName: string;
  /** null when this agent has no run with a resolved value for the current metric (e.g. no trace-derived cost yet). */
  latest: DotPlotEntry | null;
  /** Earlier runs with a resolved value, time-ascending, EXCLUDING `latest`. */
  history: DotPlotEntry[];
  /** 0-based rank after `rankDotPlotRows` (0 = top/best); -1 until ranked. */
  rank: number;
}

/**
 * Group `points` (already scoped to one benchmark by the caller) by agent
 * and split each agent's valued runs into `latest` (most recent with a
 * resolved value) + `history` (earlier ones). An agent with zero valued
 * runs for this metric still gets a row (`latest: null`) so it's visible
 * in the list rather than silently disappearing when switching metrics.
 */
export function buildBenchmarkDotPlotRows(
  points: AgentRunPoint[],
  metric: TrendMetricKey,
): BenchmarkDotPlotRow[] {
  const grouped = groupPointsByAgent(points);
  const rows: BenchmarkDotPlotRow[] = [];
  for (const [agentKey, agentPoints] of grouped) {
    const valued = agentPoints
      .map(p => ({ point: p, value: metricValue(p, metric) }))
      .filter((d): d is DotPlotEntry => d.value != null);

    const agentName = agentPoints[0].agentName;
    if (valued.length === 0) {
      rows.push({ agentKey, agentName, latest: null, history: [], rank: -1 });
      continue;
    }
    const latest = valued[valued.length - 1];
    const history = valued.slice(0, -1);
    rows.push({ agentKey, agentName, latest, history, rank: -1 });
  }
  return rows;
}

/**
 * Rank rows by latest value, best (highest) first — rows with no value for
 * the current metric sort last (still listed, just unranked among
 * themselves by name for a stable order). Stamps `rank` (0 = top) on the
 * returned copies; does not mutate the input.
 */
export function rankDotPlotRows(rows: BenchmarkDotPlotRow[]): BenchmarkDotPlotRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.latest == null && b.latest == null) return a.agentName.localeCompare(b.agentName);
    if (a.latest == null) return 1;
    if (b.latest == null) return -1;
    return b.latest.value - a.latest.value;
  });
  return sorted.map((row, index) => ({ ...row, rank: index }));
}

/**
 * Shared X-domain for a dot plot: accuracy is always anchored to the true
 * [0, 100] scale (auto-scaling to the observed min/max would visually
 * exaggerate small real-world differences, e.g. an 88-95% cluster would
 * stretch to fill the whole width). Cost/tokens are zero-anchored (0 is a
 * meaningful reference point for both) up to the observed max plus a
 * little headroom so the top dot isn't flush against the edge. Returns
 * `null` when there is nothing to plot at all.
 */
export function metricDomain(rows: BenchmarkDotPlotRow[], metric: TrendMetricKey): [number, number] | null {
  const values: number[] = [];
  for (const row of rows) {
    if (row.latest) values.push(row.latest.value);
    for (const h of row.history) values.push(h.value);
  }
  if (values.length === 0) return null;
  if (metric === 'accuracy') return [0, 100];
  const max = Math.max(...values);
  return [0, max <= 0 ? 1 : max * 1.08];
}

/** Map a value into a 0-100 position within `domain`, clamped — usable directly as a CSS `left`/`width` percentage. */
export function valueToPercent(value: number, domain: [number, number]): number {
  const [min, max] = domain;
  if (max === min) return 50;
  const pct = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, pct));
}
