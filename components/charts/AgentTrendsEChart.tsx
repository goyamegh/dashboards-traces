/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendsEChart
 *
 * Multi-agent trend chart for the landing-page "Agent trends" band.
 * One rolling-average line per agent + scatter dots for individual runs
 * (x = run time, y = the selected metric). Clicking a dot navigates to
 * that run's report page. Built on raw `echarts` (existing dep — see
 * TraceTimelineChart.tsx for the established imperative pattern), not
 * recharts, per the approved design.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { getTheme } from '@/lib/theme';
import { formatCost, formatTokens } from '@/services/metrics';
import {
  AgentRunPoint,
  TrendMetricKey,
  buildAgentColorMap,
  buildAgentTrendSeries,
  groupPointsByAgent,
} from '@/lib/agentTrends';

export interface AgentTrendsEChartProps {
  points: AgentRunPoint[];
  metric: TrendMetricKey;
  height?: number;
  onSelectRun?: (point: AgentRunPoint) => void;
  /** Agent keys whose line + dots should be excluded from the chart (legend visibility). */
  hiddenAgentKeys?: Set<string>;
}

// Trailing-window size for the rolling-average line. Not exposed as a prop
// — no caller has ever needed a different value, and a one-off approved
// visualization doesn't need speculative configurability.
const ROLLING_WINDOW = 3;

const METRIC_LABEL: Record<TrendMetricKey, string> = {
  accuracy: 'Accuracy',
  cost: 'Cost / run',
  tokens: 'Tokens / run',
};

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

export const AgentTrendsEChart: React.FC<AgentTrendsEChartProps> = ({
  points,
  metric,
  height = 280,
  onSelectRun,
  hiddenAgentKeys,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const isDarkMode = getTheme() === 'dark';
  const axisColor = isDarkMode ? 'rgb(71, 85, 105)' : 'rgb(203, 213, 225)';
  const labelColor = isDarkMode ? 'rgb(148, 163, 184)' : 'rgb(100, 116, 139)';
  const splitLineColor = isDarkMode ? 'rgb(30, 41, 59)' : 'rgb(226, 232, 240)';
  const tooltipBg = isDarkMode ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.97)';
  const tooltipBorder = isDarkMode ? 'rgba(51, 65, 85, 0.6)' : 'rgba(203, 213, 225, 0.8)';
  const tooltipText = isDarkMode ? 'rgb(226, 232, 240)' : 'rgb(30, 41, 59)';

  const { series, colorMap, hasAnyValue } = useMemo(() => {
    const grouped = groupPointsByAgent(points);
    const colorMap = buildAgentColorMap([...grouped.keys()]);
    const agentSeries = buildAgentTrendSeries(points, metric, hiddenAgentKeys ?? new Set(), ROLLING_WINDOW);
    const series: echarts.SeriesOption[] = [];
    let hasAnyValue = false;

    for (const { agentKey, agentName, lineData, scatterData } of agentSeries) {
      const color = colorMap.get(agentKey)!;
      if (scatterData.length > 0) hasAnyValue = true;

      const scatterOptionData = scatterData.map(({ point, value, isLatest }) => ({
        value: [point.timestamp, value],
        point,
        // Item-level label overrides the series-level one: every dot gets its
        // plain value; only the agent's latest dot is pinned with "name: value"
        // and marked `__pinned` so labelLayout below never hides it, even when
        // it overlaps a neighboring point's label.
        __pinned: isLatest,
        label: isLatest
          ? {
            show: true,
            formatter: () => `${agentName}: ${formatMetricValue(metric, value)}`,
            fontWeight: 600,
          }
          : undefined,
      }));

      series.push({
        id: `line-${agentKey}`,
        name: agentName,
        type: 'line',
        data: lineData,
        color,
        symbol: 'none',
        smooth: true,
        lineStyle: { width: 2 },
        z: 2,
      });
      series.push({
        id: `scatter-${agentKey}`,
        name: agentName,
        type: 'scatter',
        data: scatterOptionData,
        color,
        symbolSize: 9,
        legendHoverLink: true,
        // Per-dot value label; hidden on crowded points via the labelLayout
        // callback below (except the pinned latest-point label, which is
        // never hidden).
        label: {
          show: true,
          position: 'top',
          distance: 6,
          fontSize: 9,
          color,
          formatter: (params: any) => formatMetricValue(metric, params.value[1]),
        },
        z: 3,
      });
    }

    return { series, colorMap, hasAnyValue };
  }, [points, metric, hiddenAgentKeys]);

  const showPlaceholder = points.length === 0 || !hasAnyValue;

  // When switching into a placeholder state, the chart's container div is
  // replaced by a plain text div at the same JSX position — React reuses
  // the host node and patches its children, but it doesn't know about (and
  // won't clean up) the canvas echarts imperatively appended underneath.
  // Dispose explicitly so the old chart doesn't visually persist under the
  // placeholder message, and so switching back re-initializes cleanly.
  useEffect(() => {
    if (showPlaceholder && chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
  }, [showPlaceholder]);

  useEffect(() => {
    if (showPlaceholder) return;
    if (!containerRef.current) return;
    if (!chartRef.current) {
      // SVG renderer (vs. the canvas default) so per-dot value labels are
      // real DOM <text> nodes — this chart is on a public dashboard and gets
      // e2e-asserted on label content/visibility, which a canvas bitmap
      // can't expose to Playwright.
      chartRef.current = echarts.init(containerRef.current, undefined, { renderer: 'svg' });
    }
    const chart = chartRef.current;

    const option: echarts.EChartsOption = {
      grid: { left: 56, right: 20, top: 16, bottom: 32 },
      xAxis: {
        type: 'time',
        axisLabel: { color: labelColor, fontSize: 11 },
        axisLine: { lineStyle: { color: axisColor } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: labelColor,
          fontSize: 11,
          formatter: (val: number) => formatMetricValue(metric, val),
        },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        textStyle: { color: tooltipText, fontSize: 12 },
        formatter: (params: any) => {
          const point: AgentRunPoint | undefined = params.data?.point;
          if (!point) {
            // Rolling-average line hover: just show the smoothed value.
            return `<div style="font-weight:600">${params.seriesName}</div>${formatMetricValue(metric, params.value[1])} (rolling avg)`;
          }
          const date = new Date(point.timestamp).toLocaleString();
          return [
            `<div style="font-weight:600;margin-bottom:2px">${point.agentName}</div>`,
            `<div>${date}</div>`,
            `<div>Model: ${point.modelId || 'unknown'}</div>`,
            `<div>Pass: ${point.passed}/${point.total} (${point.accuracyPct.toFixed(1)}%)</div>`,
            `<div>Cost: ${point.costUsd != null ? formatCost(point.costUsd) : '—'}</div>`,
            `<div>Tokens: ${point.tokens != null ? formatTokens(point.tokens) : '—'}</div>`,
            `<div style="opacity:0.7;margin-top:2px">Click to open run report</div>`,
          ].join('');
        },
      },
      legend: {
        show: false, // agents drawer above already carries per-agent identity + color
      },
      // Declutter per-dot labels when runs are dense, but the pinned
      // "latest point: value" label (marked __pinned on its data item) must
      // always render regardless of overlap, per the approved design.
      labelLayout: (params: any) => {
        const seriesData = (series[params.seriesIndex] as any)?.data;
        const pinned = Boolean(seriesData?.[params.dataIndex]?.__pinned);
        return { hideOverlap: !pinned };
      },
      series,
    };

    chart.setOption(option, true);

    chart.off('click');
    chart.on('click', (params: any) => {
      if (params.seriesType === 'scatter' && params.data?.point && onSelectRun) {
        onSelectRun(params.data.point as AgentRunPoint);
      }
    });

    chart.off('mouseover');
    chart.on('mouseover', (params: any) => {
      if (containerRef.current) {
        containerRef.current.style.cursor = params.seriesType === 'scatter' ? 'pointer' : 'default';
      }
    });

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, metric, isDarkMode, showPlaceholder]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.resize();
  }, [height]);

  if (points.length === 0) {
    return (
      <div
        key="no-runs"
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ height }}
        data-testid="agent-trends-chart-empty"
      >
        No runs in the selected scope yet.
      </div>
    );
  }

  if (!hasAnyValue) {
    return (
      <div
        key="no-value"
        className="flex flex-col items-center justify-center text-muted-foreground text-sm gap-1"
        style={{ height }}
        data-testid="agent-trends-chart-empty"
      >
        <span>No {METRIC_LABEL[metric].toLowerCase()} data available for the selected runs.</span>
        {metric !== 'accuracy' && (
          <span className="text-[11px] opacity-75">
            Cost/tokens require trace data — try the Accuracy metric instead.
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      key="chart"
      ref={containerRef}
      style={{ height, width: '100%' }}
      data-testid="agent-trends-chart"
    />
  );
};
