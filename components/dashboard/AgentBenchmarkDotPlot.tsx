/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentBenchmarkDotPlot
 *
 * Primary v3 visualization for the Agent Trends band \u2014 a Cleveland-style
 * ranked dot plot of ONE benchmark's latest snapshot, replacing both the
 * v2 all-agents ECharts overlay AND the (v3-draft) sparkline-table as the
 * PRIMARY view, per owner feedback: "show the last run benchmark and show
 * its agent runs with numbers on hover and color coded for datapoints."
 *
 *   - One ROW per agent that ran the benchmark, ranked by latest score
 *     (best on top) via lib/agentTrends.ts#rankDotPlotRows.
 *   - X = the selected metric (Accuracy % | Cost/run | Tokens).
 *   - One LARGE solid dot = the agent's latest run; small faded dots =
 *     its earlier runs on the SAME benchmark (variance/history at a
 *     glance). A subtle connector line spans a row's dots \u2014 never drawn
 *     BETWEEN agents/rows.
 *   - NO on-point labels anywhere. Hover (native `title`, so it works
 *     with zero extra dependencies and needs no <TooltipProvider>
 *     ancestor for a component test) carries agent/value/date; clicking
 *     a dot opens that run's report.
 *   - Colored per agent via lib/dashboardMetrics.ts#getAgentColor \u2014 the
 *     app-wide agent color hook \u2014 so this chart's colors are consistent
 *     with the rest of the app, not a one-off palette.
 *
 * Positioning is plain CSS percentages (`left: X%`) computed from
 * lib/agentTrends.ts#valueToPercent, not an SVG charting library: every
 * row shares the exact same `flex-1` plot column via flexbox, so ticks
 * and dots always line up without measuring pixel widths, and it renders
 * identically under JSDOM for component tests (no ResizeObserver/canvas).
 */

import React from 'react';
import {
  BenchmarkDotPlotRow, formatMetricValue, metricDomain, TrendMetricKey, valueToPercent,
} from '@/lib/agentTrends';
import { getAgentColor } from '@/lib/dashboardMetrics';

export interface AgentBenchmarkDotPlotProps {
  rows: BenchmarkDotPlotRow[]; // already ranked (rankDotPlotRows)
  metric: TrendMetricKey;
  onSelectPoint: (row: BenchmarkDotPlotRow, runDocId: string, benchmarkId: string) => void;
}

const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
const NAME_COL_WIDTH = 132;

function dotTitle(agentName: string, metric: TrendMetricKey, entry: { point: { timestamp: number; modelId: string; passed: number; total: number }; value: number }, isLatest: boolean): string {
  const date = new Date(entry.point.timestamp).toLocaleString();
  const lines = [
    `${agentName}${isLatest ? ' (latest)' : ''}`,
    `${formatMetricValue(metric, entry.value)} \u00b7 ${date}`,
    `Model: ${entry.point.modelId || 'unknown'} \u00b7 Pass ${entry.point.passed}/${entry.point.total}`,
    'Click to open run report',
  ];
  return lines.join('\n');
}

export const AgentBenchmarkDotPlot: React.FC<AgentBenchmarkDotPlotProps> = ({ rows, metric, onSelectPoint }) => {
  const domain = metricDomain(rows, metric);

  if (!domain || rows.every(r => r.latest == null)) {
    return (
      <div
        className="flex flex-col items-center justify-center text-muted-foreground text-sm gap-1 h-[220px]"
        data-testid="agent-dot-plot-empty"
      >
        <span>No {metric === 'accuracy' ? 'accuracy' : metric} data available for this benchmark.</span>
        {metric !== 'accuracy' && (
          <span className="text-[11px] opacity-75">Cost/tokens require trace data \u2014 try the Accuracy metric instead.</span>
        )}
      </div>
    );
  }

  return (
    <div data-testid="agent-dot-plot" className="text-xs">
      {/* Shared tick header \u2014 same name-column + flex-1 plot-column split as every row, so ticks line up without measuring pixels. */}
      <div className="flex items-center gap-2 mb-1" style={{ paddingLeft: NAME_COL_WIDTH + 8 }} data-testid="agent-dot-plot-ticks">
        <div className="relative flex-1 h-3">
          {TICK_FRACTIONS.map(frac => {
            const value = domain[0] + frac * (domain[1] - domain[0]);
            return (
              <span
                key={frac}
                className="absolute -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums"
                style={{ left: `${frac * 100}%` }}
              >
                {formatMetricValue(metric, value)}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col">
        {rows.map(row => {
          const color = getAgentColor(row.agentKey);
          const allEntries = row.latest ? [...row.history, row.latest] : row.history;
          const percents = allEntries.map(e => valueToPercent(e.value, domain));
          const minPct = percents.length > 0 ? Math.min(...percents) : null;
          const maxPct = percents.length > 0 ? Math.max(...percents) : null;

          return (
            <div
              key={row.agentKey}
              className="flex items-center gap-2 h-8 border-b border-border/60 last:border-b-0"
              data-testid={`agent-dot-plot-row-${row.agentKey}`}
            >
              <span
                className="text-[11px] font-medium truncate shrink-0"
                style={{ width: NAME_COL_WIDTH }}
                title={row.agentName}
              >
                {row.agentName}
              </span>
              <div className="relative flex-1 h-full">
                {/* Faint tick gridlines, per-row (avoids cross-row absolute-overlay alignment math). */}
                {TICK_FRACTIONS.map(frac => (
                  <div
                    key={frac}
                    aria-hidden="true"
                    className="absolute inset-y-0 border-l border-dashed border-border/40"
                    style={{ left: `${frac * 100}%` }}
                  />
                ))}

                {row.latest == null ? (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                    no {metric} data
                  </span>
                ) : (
                  <>
                    {minPct != null && maxPct != null && maxPct > minPct && (
                      <div
                        aria-hidden="true"
                        className="absolute h-px top-1/2 -translate-y-1/2"
                        style={{ left: `${minPct}%`, width: `${maxPct - minPct}%`, backgroundColor: color, opacity: 0.3 }}
                      />
                    )}

                    {row.history.map((entry, i) => (
                      <button
                        key={entry.point.runDocId}
                        type="button"
                        data-testid={`agent-dot-plot-history-${row.agentKey}-${i}`}
                        title={dotTitle(row.agentName, metric, entry, false)}
                        onClick={() => onSelectPoint(row, entry.point.runDocId, entry.point.benchmarkId)}
                        className="absolute top-1/2 rounded-full -translate-x-1/2 -translate-y-1/2 opacity-45 hover:opacity-80 transition-opacity"
                        style={{ left: `${valueToPercent(entry.value, domain)}%`, width: 7, height: 7, backgroundColor: color }}
                      />
                    ))}

                    <button
                      type="button"
                      data-testid={`agent-dot-plot-latest-${row.agentKey}`}
                      title={dotTitle(row.agentName, metric, row.latest, true)}
                      onClick={() => onSelectPoint(row, (row.latest as NonNullable<typeof row.latest>).point.runDocId, (row.latest as NonNullable<typeof row.latest>).point.benchmarkId)}
                      className="absolute top-1/2 rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-background hover:scale-110 transition-transform"
                      style={{ left: `${valueToPercent(row.latest.value, domain)}%`, width: 14, height: 14, backgroundColor: color }}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
