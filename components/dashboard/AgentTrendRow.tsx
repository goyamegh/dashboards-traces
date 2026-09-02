/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendRow
 *
 * One row of the "all agents / history" drawer (AgentTrendsAgentListDrawer):
 * agent name, compact sparkline (AgentTrendSparkline) of its runs over
 * time, latest value for the current metric, and a Δ-vs-previous-run
 * badge with a color arrow. Clicking a row opens that agent's latest run
 * report (`onSelect`) — this is now the secondary "how has this agent
 * trended over time" view; the primary Agent Trends visualization is the
 * ranked dot plot (AgentBenchmarkDotPlot).
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { AgentTrendRow as AgentTrendRowData, formatMetricValue, TrendMetricKey } from '@/lib/agentTrends';
import { AgentTrendSparkline, sparklineTitle } from '@/components/dashboard/AgentTrendSparkline';

export interface AgentTrendRowProps {
  row: AgentTrendRowData;
  metric: TrendMetricKey;
  onSelect: (agentKey: string) => void;
}

function directionOf(delta: number | null): 'up' | 'down' | 'neutral' {
  if (delta == null || Math.abs(delta) < 1e-9) return 'neutral';
  return delta > 0 ? 'up' : 'down';
}

function DeltaTag({ metric, delta }: { metric: TrendMetricKey; delta: number | null }) {
  const direction = directionOf(delta);
  if (direction === 'neutral') {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground text-[10px]" data-testid="agent-trend-row-delta">
        <Minus className="h-2.5 w-2.5" /> {delta == null ? 'n/a' : (metric === 'accuracy' ? '±0pp' : '±0')}
      </span>
    );
  }
  const isUp = direction === 'up';
  const magnitude = metric === 'accuracy'
    ? `${Math.abs(Math.round((delta as number) * 10) / 10)}pp`
    : formatMetricValue(metric, Math.abs(delta as number));
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] ${isUp ? 'text-emerald-500' : 'text-red-500'}`}
      data-testid="agent-trend-row-delta"
    >
      {isUp ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
      {isUp ? '+' : '-'}{magnitude}
    </span>
  );
}

export const AgentTrendRow: React.FC<AgentTrendRowProps> = ({ row, metric, onSelect }) => {
  const direction = directionOf(row.delta);

  return (
    <button
      type="button"
      onClick={() => onSelect(row.agentKey)}
      data-testid={`agent-trend-row-${row.agentKey}`}
      title={sparklineTitle(row.agentName, metric, row.series)}
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-muted/50"
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium" data-testid="agent-trend-row-name">
        {row.agentName}
      </span>
      <AgentTrendSparkline series={row.series} metric={metric} latestDirection={direction} />
      <span className="w-14 text-right text-[11px] font-semibold tabular-nums shrink-0" data-testid="agent-trend-row-latest">
        {row.latestValue != null ? formatMetricValue(metric, row.latestValue) : '—'}
      </span>
      <span className="w-14 shrink-0 text-right">
        <DeltaTag metric={metric} delta={row.delta} />
      </span>
    </button>
  );
};
