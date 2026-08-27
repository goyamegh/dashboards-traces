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
  groupPointsByAgent,
  metricValue,
  rollingAverage,
} from '@/lib/agentTrends';

export interface AgentTrendsEChartProps {
  points: AgentRunPoint[];
  metric: TrendMetricKey;
  height?: number;
  onSelectRun?: (point: AgentRunPoint) => void;
  rollingWindow?: number;
}

const METRIC_LABEL: Record<TrendMetricKey, string> = {
  accuracy: 'Accuracy',
  cost: 'Cost / run',
  tokens: 'Tokens / run',
};

function formatMetricValue(metric: TrendMetricKey, value: number): string {
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
  rollingWindow = 3,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const pointsRef = useRef<AgentRunPoint[]>(points);
  pointsRef.current = points;

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
    const series: echarts.SeriesOption[] = [];
    let hasAnyValue = false;

    for (const [agentKey, agentPoints] of grouped) {
      const color = colorMap.get(agentKey)!;
      const rawValues = agentPoints.map(p => metricValue(p, metric));
      if (rawValues.some(v => v != null)) hasAnyValue = true;
      const rolling = rollingAverage(rawValues, rollingWindow);

      const lineData = agentPoints
        .map((p, i) => (rolling[i] != null ? [p.timestamp, rolling[i]] : null))
        .filter((d): d is [number, number] => d != null);

      const scatterData = agentPoints
        .map((p, i) => ({ p, v: rawValues[i] }))
        .filter((d): d is { p: AgentRunPoint; v: number } => d.v != null)
        .map(({ p, v }) => ({
          value: [p.timestamp, v],
          point: p,
        }));

      series.push({
        id: `line-${agentKey}`,
        name: agentPoints[0].agentName,
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
        name: agentPoints[0].agentName,
        type: 'scatter',
        data: scatterData,
        color,
        symbolSize: 9,
        legendHoverLink: true,
        z: 3,
      });
    }

    return { series, colorMap, hasAnyValue };
  }, [points, metric, rollingWindow]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(containerRef.current);
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
        show: false, // chips row above already carries per-agent identity + color
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
  }, [series, metric, isDarkMode]);

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
      ref={containerRef}
      style={{ height, width: '100%' }}
      data-testid="agent-trends-chart"
    />
  );
};
