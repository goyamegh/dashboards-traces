/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { CheckCircle2 } from 'lucide-react';
import { RunAggregateMetrics } from '@/types';
import { formatCost, formatDuration, formatTokens } from '@/services/metrics';
import { cn } from '@/lib/utils';

const RUN_COLORS = ['#3b82f6', '#015aa3', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

type Dir = 'higher' | 'lower' | 'neutral';

interface MetricDef {
  key: string;
  label: string;
  dir: Dir;            // direction that counts as "better" (drives the ✓)
  graphable: boolean;  // shares the 0-100% axis → goes in the bar chart
  get: (r: RunAggregateMetrics) => number | undefined;
  fmt: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v)}%`;
const METRICS: MetricDef[] = [
  { key: 'pass', label: 'Pass Rate', dir: 'higher', graphable: true, get: r => r.passRatePercent, fmt: pct },
  { key: 'acc', label: 'Avg Accuracy', dir: 'higher', graphable: true, get: r => r.avgAccuracy, fmt: pct },
  { key: 'dur', label: 'Avg Duration', dir: 'lower', graphable: false, get: r => r.avgDurationMs, fmt: formatDuration },
  { key: 'cost', label: 'Cost', dir: 'lower', graphable: false, get: r => r.totalCostUsd, fmt: formatCost },
  { key: 'tok', label: 'Total Tokens', dir: 'lower', graphable: false, get: r => r.totalTokens, fmt: formatTokens },
  { key: 'llm', label: 'LLM Calls', dir: 'neutral', graphable: false, get: r => r.totalLlmCalls, fmt: v => v.toLocaleString() },
  { key: 'tool', label: 'Tool Calls', dir: 'neutral', graphable: false, get: r => r.totalToolCalls, fmt: v => v.toLocaleString() },
];

interface Props {
  runs: RunAggregateMetrics[];
}

/** Best run index for a metric (direction-aware); -1 when not comparable. */
function bestIndex(m: MetricDef, runs: RunAggregateMetrics[]): number {
  if (m.dir === 'neutral' || runs.length < 2) return -1;
  let best = m.dir === 'higher' ? -Infinity : Infinity;
  let idx = -1;
  runs.forEach((r, i) => {
    const v = m.get(r);
    if (typeof v === 'number' && (m.dir === 'higher' ? v > best : v < best)) { best = v; idx = i; }
  });
  return idx;
}

/**
 * MetricComparisonPanel — one visualization unit for the detailed metrics:
 *   1. a grouped BAR CHART of the graphable, same-scale (0-100%) quality
 *      metrics — pass rate, accuracy, faithfulness, trajectory, latency —
 *      one bar per run, only the metrics that have signal.
 *   2. a MATRIX (metrics × runs) below it listing every metric (including the
 *      different-scale ones: duration, cost, tokens, LLM/tool calls), with the
 *      winning run marked and "—" where a metric wasn't recorded.
 */
export const MetricComparisonPanel: React.FC<Props> = ({ runs }) => {
  const series = useMemo(
    () => runs.map((r, i) => ({ run: r, idx: i, color: RUN_COLORS[i % RUN_COLORS.length], label: `#${i + 1}` })),
    [runs]
  );

  // Bar chart: graphable %-metrics that at least one run actually recorded.
  const chart = useMemo(() => {
    const metrics = METRICS.filter(m => m.graphable && runs.some(r => { const v = m.get(r); return typeof v === 'number' && v > 0; }));
    const data = metrics.map(m => {
      const row: Record<string, string | number> = { metric: m.label };
      runs.forEach((r, i) => { const v = m.get(r); row[`r${i}`] = typeof v === 'number' ? Math.round(v) : 0; });
      return row;
    });
    return { metrics, data };
  }, [runs]);

  if (runs.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* ── Bar chart: comparable quality metrics ─────────────── */}
      {chart.data.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-foreground/80 mb-2">Quality metrics (higher is better)</div>
          <ResponsiveContainer width="100%" height={Math.max(180, 40 + chart.data.length * 26 * Math.min(runs.length, 4) / 2)}>
            <BarChart data={chart.data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="22%">
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis dataKey="metric" tick={{ fill: '#9ca3af', fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={36} />
              <Tooltip
                formatter={(value: number, name: string) => [`${value}%`, name]}
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                cursor={{ fill: 'rgba(148,163,184,0.08)' }}
              />
              <Legend wrapperStyle={{ paddingTop: 6 }} formatter={(value) => <span className="text-xs text-muted-foreground">{value}</span>} />
              {series.map(({ run, idx, color, label }) => (
                <Bar key={run.runId} dataKey={`r${idx}`} name={`${label} ${run.runName}`} fill={color} radius={[3, 3, 0, 0]} maxBarSize={48} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Matrix: every metric × every run ──────────────────── */}
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left font-medium text-muted-foreground px-3 py-2 sticky left-0 bg-card">Metric</th>
              {series.map(({ run, color, label }) => (
                <th key={run.runId} className="text-right font-medium px-3 py-2 whitespace-nowrap">
                  <span className="font-mono font-semibold mr-1" style={{ color }}>{label}</span>
                  <span className="text-muted-foreground max-w-[140px] inline-block align-bottom truncate" title={run.runName}>{run.runName}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map(m => {
              const vals = runs.map(m.get);
              const recorded = vals.some(v => typeof v === 'number' && v > 0);
              const best = recorded ? bestIndex(m, runs) : -1;
              return (
                <tr key={m.key} className={cn('border-b border-border/40 last:border-0', !recorded && 'opacity-50')}>
                  <td className="text-left px-3 py-1.5 text-foreground/80 sticky left-0 bg-card whitespace-nowrap">
                    {m.label}
                    {m.dir !== 'neutral' && <span className="ml-1.5 text-[9px] text-muted-foreground uppercase">{m.dir === 'higher' ? '↑' : '↓'}</span>}
                  </td>
                  {vals.map((v, i) => (
                    <td
                      key={i}
                      data-testid={m.key === 'pass' ? `run-passrate-${runs[i].runId}` : m.key === 'acc' ? `run-accuracy-${runs[i].runId}` : undefined}
                      className="text-right px-3 py-1.5 tabular-nums whitespace-nowrap"
                    >
                      {!recorded ? (
                        <span className="text-muted-foreground italic">—</span>
                      ) : (
                        <span className={cn('inline-flex items-center justify-end gap-1', i === best && 'font-semibold')}>
                          {typeof v === 'number' ? m.fmt(v) : <span className="text-muted-foreground">—</span>}
                          {i === best && <CheckCircle2 size={11} className="text-green-500 shrink-0" />}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MetricComparisonPanel;
