/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendsBand — v3
 *
 * Landing-page "Agent trends" band. Replaces the v2 all-agents ECharts
 * overlay (one line + scatter series per agent, shared 10-color palette,
 * on-point "name: value" labels pinned at every agent's latest run) with
 * a ranked dot plot of the LAST-ACTIVE benchmark, per owner feedback that
 * the overlay became unreadable past ~10 agents (labels collided at the
 * right edge, sparse per-agent runs produced misleading long interpolated
 * lines across silent gaps, all-errored runs plotted as a literal — and
 * indistinguishable-from-real — 0.0%, and 14 agents sharing a 10-color
 * palette made several lines indistinguishable) — and per a follow-up
 * design pivot ("show the last run benchmark and show its agent runs
 * with numbers on hover and color coded for datapoints") replacing an
 * intermediate sparkline-table draft as the PRIMARY view.
 *
 * New shape:
 *   1. Metric toggle (Accuracy % | Cost/run | Tokens) + benchmark
 *      selector (defaults to the benchmark with the most recent run) +
 *      time-range scoping.
 *   2. PRIMARY: AgentBenchmarkDotPlot — one row per agent that ran the
 *      selected benchmark, ranked by latest score (best on top), one
 *      large solid dot per agent's latest run + small faded dots for its
 *      earlier runs on that SAME benchmark. No on-point labels; hover
 *      carries the numbers, click opens the run report.
 *   3. SECONDARY: a "History (N agents)" drawer — the sparkline-table
 *      draft (AgentTrendRow + AgentTrendSparkline), kept as the
 *      "how has each agent trended over time" view across the full
 *      benchmark/time scope (not just the one benchmark the dot plot
 *      shows); a row click opens that agent's latest run report.
 *
 * See .pi/web/artifacts/trends-v3/ for the before/after screenshots.
 */

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Benchmark, EvaluationReport } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AgentRunPoint,
  buildAgentRunPoints,
  buildAgentTrendRows,
  buildBenchmarkDotPlotRows,
  BenchmarkDotPlotRow,
  getMostRecentlyActiveBenchmarkId,
  RunMetricsLookup,
  rankDotPlotRows,
  sortAgentTrendRows,
  timeRangeToSinceMs,
  TrendMetricKey,
  TrendsTimeRange,
} from '@/lib/agentTrends';
import { AgentBenchmarkDotPlot } from '@/components/dashboard/AgentBenchmarkDotPlot';
import { AgentTrendsAgentListDrawer } from '@/components/dashboard/AgentTrendsAgentListDrawer';

export interface AgentTrendsBandProps {
  benchmarks: Benchmark[];
  reports: EvaluationReport[];
  metricsMap: Map<string, RunMetricsLookup>;
  getAgentDisplayName: (agentKey: string) => string;
}

const METRIC_OPTIONS: Array<{ value: TrendMetricKey; label: string }> = [
  { value: 'accuracy', label: 'Accuracy %' },
  { value: 'cost', label: 'Cost/run' },
  { value: 'tokens', label: 'Tokens' },
];

const TIME_RANGE_OPTIONS: Array<{ value: TrendsTimeRange; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

export const AgentTrendsBand: React.FC<AgentTrendsBandProps> = ({
  benchmarks, reports, metricsMap, getAgentDisplayName,
}) => {
  const navigate = useNavigate();

  const defaultBenchmarkId = useMemo(() => getMostRecentlyActiveBenchmarkId(benchmarks), [benchmarks]);

  // No "All benchmarks" choice here (unlike v2): a ranked dot plot needs ONE
  // coherent benchmark scope to rank agents against each other meaningfully.
  // A persisted value from before this redesign (or one that no longer
  // exists) simply fails the `benchmarks.some(...)` check below and falls
  // back to the most-recently-active benchmark — no migration code needed.
  const [benchmarkId, setBenchmarkId] = usePersistedState<string>('dashboard:trendsBenchmarkId', '');
  const [timeRange, setTimeRange] = usePersistedState<TrendsTimeRange>('dashboard:trendsTimeRange', '30d');
  const [metric, setMetric] = usePersistedState<TrendMetricKey>('dashboard:trendsMetric', 'accuracy');

  const effectiveBenchmarkId = benchmarks.some(b => b.id === benchmarkId) ? benchmarkId : defaultBenchmarkId;
  const effectiveBenchmark = benchmarks.find(b => b.id === effectiveBenchmarkId) ?? null;

  // All points across every benchmark in scope (time-range filtered) — feeds
  // the secondary "history" drawer, which intentionally is NOT scoped to a
  // single benchmark (it's the "how has this agent trended overall" view).
  const allPoints = useMemo<AgentRunPoint[]>(() => buildAgentRunPoints(
    benchmarks,
    reports,
    metricsMap,
    { sinceMs: timeRangeToSinceMs(timeRange), agentDisplayName: getAgentDisplayName },
  ), [benchmarks, reports, metricsMap, timeRange, getAgentDisplayName]);

  // Just the selected benchmark's points — feeds the primary dot plot.
  const benchmarkPoints = useMemo<AgentRunPoint[]>(
    () => (effectiveBenchmarkId ? allPoints.filter(p => p.benchmarkId === effectiveBenchmarkId) : []),
    [allPoints, effectiveBenchmarkId],
  );

  const dotPlotRows = useMemo<BenchmarkDotPlotRow[]>(
    () => rankDotPlotRows(buildBenchmarkDotPlotRows(benchmarkPoints, metric)),
    [benchmarkPoints, metric],
  );

  const historyRows = useMemo(
    () => sortAgentTrendRows(buildAgentTrendRows(allPoints, metric), 'latest'),
    [allPoints, metric],
  );

  const goToRun = (benchmarkIdForRun: string, runDocId: string) =>
    navigate(`/evaluations/benchmarks/${benchmarkIdForRun}/runs/${runDocId}/inspect`);

  const goToAgentLatestRun = (agentKey: string) => {
    const row = historyRows.find(r => r.agentKey === agentKey);
    if (row?.latestBenchmarkId && row?.latestRunDocId) {
      goToRun(row.latestBenchmarkId, row.latestRunDocId);
    }
  };

  return (
    <Card className="flex flex-col" data-testid="agent-trends-band">
      <CardHeader className="pb-2 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="agent-trends-header-row">
          <CardTitle className="text-sm mr-auto shrink-0" title="Latest per-agent snapshot for one benchmark, ranked by score.">
            Agent Trends
          </CardTitle>

          <div className="flex items-center gap-1" data-testid="agent-trends-metric-toggle">
            {METRIC_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                data-testid={`agent-trends-metric-${opt.value}`}
                onClick={() => setMetric(opt.value)}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                  metric === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <AgentTrendsAgentListDrawer
            rows={historyRows}
            metric={metric}
            onSelectAgent={goToAgentLatestRun}
          />

          <div className="flex items-center gap-1.5 shrink-0" data-testid="agent-trends-controls">
            <Select value={effectiveBenchmarkId ?? ''} onValueChange={setBenchmarkId}>
              <SelectTrigger className="h-7 w-[180px] text-[11px]" data-testid="agent-trends-benchmark-select">
                <SelectValue placeholder="Benchmark" />
              </SelectTrigger>
              <SelectContent>
                {benchmarks.map(b => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={timeRange} onValueChange={v => setTimeRange(v as TrendsTimeRange)}>
              <SelectTrigger className="h-7 w-[105px] text-[11px]" data-testid="agent-trends-range-select">
                <SelectValue placeholder="Range" />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-3 pb-3 pt-0 flex-1 flex flex-col gap-2">
        {benchmarks.length === 0 ? (
          <div
            className="flex items-center justify-center text-muted-foreground text-sm h-[220px]"
            data-testid="agent-trends-empty-no-benchmarks"
          >
            No benchmarks yet — run a benchmark to start tracking agent trends.
          </div>
        ) : dotPlotRows.length === 0 ? (
          <div
            className="flex items-center justify-center text-muted-foreground text-sm h-[220px]"
            data-testid="agent-trends-empty-no-runs"
          >
            No runs for {effectiveBenchmark?.name ?? 'this benchmark'} in the selected time range.
          </div>
        ) : (
          <>
            <div className="text-[11px] text-muted-foreground px-0.5" data-testid="agent-trends-scope-label">
              Latest snapshot — <span className="font-medium text-foreground">{effectiveBenchmark?.name}</span>
            </div>
            <AgentBenchmarkDotPlot
              rows={dotPlotRows}
              metric={metric}
              onSelectPoint={(_row, runDocId, benchmarkIdForRun) => goToRun(benchmarkIdForRun, runDocId)}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};
