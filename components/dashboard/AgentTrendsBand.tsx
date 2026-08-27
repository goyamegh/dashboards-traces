/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendsBand
 *
 * Landing-page "Agent trends" band — replaces the old Performance Trends
 * card (recharts area/line chart + Filter Chips) with:
 *   1. Per-agent summary chips (latest accuracy + WoW delta + cost/tokens per run)
 *   2. One multi-agent ECharts trend chart (rolling avg line + per-run dots)
 *   3. Metric toggle: Accuracy % | Cost/run | Tokens
 *   4. Scoping controls: benchmark selector + time range (7/30/90d)
 *
 * See .pi/web/artifacts/trends-viz-mock.html for the approved visual design.
 */

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Benchmark, EvaluationReport } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatCost, formatTokens } from '@/services/metrics';
import { AgentTrendsEChart } from '@/components/charts/AgentTrendsEChart';
import {
  AgentRunPoint,
  RunMetricsLookup,
  TrendMetricKey,
  TrendsTimeRange,
  buildAgentColorMap,
  buildAgentRunPoints,
  computeAgentChipSummaries,
  getMostRecentlyActiveBenchmarkId,
  timeRangeToSinceMs,
} from '@/lib/agentTrends';

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

function DeltaBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
        <Minus className="h-3 w-3" /> n/a
      </span>
    );
  }
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded) < 0.05) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
        <Minus className="h-3 w-3" /> 0pp
      </span>
    );
  }
  const isUp = rounded > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {isUp ? '+' : ''}{rounded}pp
    </span>
  );
}

export const AgentTrendsBand: React.FC<AgentTrendsBandProps> = ({
  benchmarks, reports, metricsMap, getAgentDisplayName,
}) => {
  const navigate = useNavigate();

  const defaultBenchmarkId = useMemo(() => getMostRecentlyActiveBenchmarkId(benchmarks), [benchmarks]);

  const [benchmarkId, setBenchmarkId] = usePersistedState<string>('dashboard:trendsBenchmarkId', 'all');
  const [timeRange, setTimeRange] = usePersistedState<TrendsTimeRange>('dashboard:trendsTimeRange', '30d');
  const [metric, setMetric] = usePersistedState<TrendMetricKey>('dashboard:trendsMetric', 'accuracy');

  // "all" is a valid persisted choice; otherwise fall back to the most
  // recently active benchmark until the user has ever picked something.
  const effectiveBenchmarkId = benchmarkId === 'all' || benchmarks.some(b => b.id === benchmarkId)
    ? benchmarkId
    : (defaultBenchmarkId ?? 'all');

  const points = useMemo<AgentRunPoint[]>(() => buildAgentRunPoints(
    benchmarks,
    reports,
    metricsMap,
    {
      benchmarkId: effectiveBenchmarkId === 'all' ? null : effectiveBenchmarkId,
      sinceMs: timeRangeToSinceMs(timeRange),
      agentDisplayName: getAgentDisplayName,
    },
  ), [benchmarks, reports, metricsMap, effectiveBenchmarkId, timeRange, getAgentDisplayName]);

  const chips = useMemo(() => computeAgentChipSummaries(points), [points]);
  const colorMap = useMemo(() => buildAgentColorMap(chips.map(c => c.agentKey)), [chips]);

  const hasEnoughData = points.length >= 2;

  const goToRun = (point: AgentRunPoint) =>
    navigate(`/evaluations/benchmarks/${point.benchmarkId}/runs/${point.runDocId}/inspect`);

  return (
    <Card data-testid="agent-trends-band">
      <CardHeader className="pb-2 px-4 pt-3 space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">Agent Trends</CardTitle>
            <CardDescription className="text-[11px] leading-tight">
              Accuracy, cost, and tokens per run — one line per agent.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5 shrink-0" data-testid="agent-trends-controls">
            <Select value={effectiveBenchmarkId} onValueChange={setBenchmarkId}>
              <SelectTrigger className="h-7 w-[160px] text-[11px]" data-testid="agent-trends-benchmark-select">
                <SelectValue placeholder="Benchmark" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All benchmarks</SelectItem>
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

        {/* Metric toggle */}
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

        {/* Chips row */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="agent-trends-chips">
            {chips.map(chip => (
              <div
                key={chip.agentKey}
                className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] min-w-[150px]"
                style={{ borderLeft: `3px solid ${colorMap.get(chip.agentKey)}` }}
                data-testid={`agent-trends-chip-${chip.agentKey}`}
              >
                <div className="flex items-center gap-1.5 font-medium truncate max-w-[220px]">
                  {chip.agentName}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="font-semibold tabular-nums">
                    {chip.latestAccuracyPct != null ? `${chip.latestAccuracyPct.toFixed(1)}%` : '—'}
                  </span>
                  <DeltaBadge value={chip.wowDeltaPct} />
                </div>
                <div className="text-muted-foreground mt-0.5">
                  {chip.latestCostUsd != null ? formatCost(chip.latestCostUsd) : '—'}/run
                  {' · '}
                  {chip.latestTokens != null ? formatTokens(chip.latestTokens) : '—'} tok
                </div>
              </div>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent className="px-2 pb-3 pt-0">
        {benchmarks.length === 0 ? (
          <div
            className="flex items-center justify-center text-muted-foreground text-sm h-[220px]"
            data-testid="agent-trends-empty-no-benchmarks"
          >
            No benchmarks yet — run a benchmark to start tracking agent trends.
          </div>
        ) : !hasEnoughData ? (
          <div
            className="flex items-center justify-center text-muted-foreground text-sm h-[220px]"
            data-testid="agent-trends-empty-not-enough-runs"
          >
            Need at least 2 runs in the selected scope to show a trend.
          </div>
        ) : (
          <AgentTrendsEChart points={points} metric={metric} height={260} onSelectRun={goToRun} />
        )}
      </CardContent>
    </Card>
  );
};
