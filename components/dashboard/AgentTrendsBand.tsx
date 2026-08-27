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
import { usePersistedState } from '@/hooks/usePersistedState';
import { Benchmark, EvaluationReport } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { AgentTrendsEChart } from '@/components/charts/AgentTrendsEChart';
import { AgentTrendsLegendDrawer } from '@/components/dashboard/AgentTrendsLegendDrawer';
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

  // Hidden set (not visible set) so a newly-seen agent defaults to visible —
  // legend visibility only ever needs to remember exceptions. Persisted so a
  // user's "hide the noisy agent" choice survives a reload.
  const [hiddenAgentKeys, setHiddenAgentKeys] = usePersistedState<string[]>('dashboard:trendsHiddenAgents', []);
  const hiddenSet = useMemo(() => new Set(hiddenAgentKeys), [hiddenAgentKeys]);
  const toggleAgentVisibility = (agentKey: string) => {
    setHiddenAgentKeys(prev => (
      prev.includes(agentKey) ? prev.filter(k => k !== agentKey) : [...prev, agentKey]
    ));
  };

  const hasEnoughData = points.length >= 2;

  const goToRun = (point: AgentRunPoint) =>
    navigate(`/evaluations/benchmarks/${point.benchmarkId}/runs/${point.runDocId}/inspect`);

  return (
    <Card data-testid="agent-trends-band">
      <CardHeader className="pb-2 px-4 pt-3">
        {/* Single header row: title, metric toggle, agents drawer, scoping selects. */}
        <div className="flex flex-wrap items-center gap-1.5" data-testid="agent-trends-header-row">
          <CardTitle className="text-sm mr-auto shrink-0" title="Accuracy, cost, and tokens per run — one line per agent.">
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

          <AgentTrendsLegendDrawer
            chips={chips}
            colorMap={colorMap}
            hiddenAgentKeys={hiddenSet}
            onToggleAgent={toggleAgentVisibility}
          />

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
          <AgentTrendsEChart
            points={points}
            metric={metric}
            height={260}
            onSelectRun={goToRun}
            hiddenAgentKeys={hiddenSet}
          />
        )}
      </CardContent>
    </Card>
  );
};
