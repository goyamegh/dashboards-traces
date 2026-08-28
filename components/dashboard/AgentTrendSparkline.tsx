/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendSparkline
 *
 * Compact, axis-free per-agent sparkline for one row of the Agent Trends
 * sparkline-table. Renders the SAME gap-broken series (`TrendSeriesEntry[]`
 * from lib/agentTrends.ts#buildGapBrokenSeries) the focused detail chart
 * uses, at a fixed small size — no axes, no gridlines, no on-point value
 * labels (the row's own "latest value" + delta text already carries that;
 * hovering the sparkline dot still surfaces a native title tooltip so the
 * per-run detail isn't lost, just not drawn on-canvas).
 *
 * Deliberately given explicit numeric width/height (not
 * `<ResponsiveContainer>`), which is the right call for a fixed-size
 * sparkline AND makes it render deterministically under JSDOM (no
 * ResizeObserver needed) for any future component-level test.
 *
 * A single, theme-aware accent color (`currentColor`, driven by the
 * wrapping element's `text-*` class) is used for the line — no per-agent
 * hue. See lib/agentTrends.ts's `AGENT_PALETTE` removal note: a
 * small-multiples layout doesn't need N distinct colors to keep 14 agents
 * apart, because every row is already labeled by name.
 */

import React from 'react';
import { Line, LineChart } from 'recharts';
import { formatMetricValue, TrendMetricKey, TrendSeriesEntry } from '@/lib/agentTrends';

export interface AgentTrendSparklineProps {
  series: TrendSeriesEntry[];
  metric: TrendMetricKey;
  width?: number;
  height?: number;
  /** Semantic dot coloring for the latest point: up (green) / down (red) / neutral. */
  latestDirection?: 'up' | 'down' | 'neutral';
}

const DIRECTION_COLOR: Record<'up' | 'down' | 'neutral', string> = {
  up: 'rgb(16, 185, 129)', // emerald-500
  down: 'rgb(239, 68, 68)', // red-500
  neutral: 'currentColor',
};

function SparklineDot(props: any, latestTimestamp: number, latestColor: string) {
  const { cx, cy, payload } = props;
  if (payload?.value == null || cx == null || cy == null) return <circle cx={0} cy={0} r={0} />;
  const isLatest = payload.timestamp === latestTimestamp;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isLatest ? 2.5 : 1.75}
      fill={isLatest ? latestColor : 'currentColor'}
      stroke="none"
    />
  );
}

export const AgentTrendSparkline: React.FC<AgentTrendSparklineProps> = ({
  series, metric, width = 96, height = 28, latestDirection = 'neutral',
}) => {
  const plotted = series.filter(s => s.value != null);
  const latestTimestamp = plotted.length > 0 ? plotted[plotted.length - 1].timestamp : -1;
  const latestColor = DIRECTION_COLOR[latestDirection];

  if (plotted.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-muted-foreground"
        style={{ width, height }}
        data-testid="agent-trend-sparkline-empty"
      >
        no data
      </div>
    );
  }

  return (
    <div className="text-muted-foreground/80" style={{ width, height }} data-testid="agent-trend-sparkline">
      <LineChart width={width} height={height} data={series} margin={{ top: 4, right: 3, bottom: 4, left: 3 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke="currentColor"
          strokeWidth={1.5}
          dot={(props: any) => SparklineDot(props, latestTimestamp, latestColor)}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
};

/** Small helper shared by row/drawer: a browser-native tooltip summarizing the sparkline's data, since no on-canvas labels are drawn. */
export function sparklineTitle(agentName: string, metric: TrendMetricKey, series: TrendSeriesEntry[]): string {
  const plotted = series.filter(s => s.value != null && s.point);
  if (plotted.length === 0) return `${agentName}: no ${metric} data in scope`;
  const lines = plotted.slice(-5).map(s => {
    const date = new Date(s.timestamp).toLocaleDateString();
    return `${date}: ${formatMetricValue(metric, s.value as number)}`;
  });
  return [`${agentName} — last ${lines.length} run${lines.length === 1 ? '' : 's'}:`, ...lines].join('\n');
}
