/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DeepDiveHeaderMetrics — compact, single-line A-vs-B numbers for the
 * ComparisonDeepDive ("What's actually different") panel header.
 *
 * Owner feedback on the deep-dive panel (screenshot-verified):
 *   1. The panel's "Performance & Outcome" bars showed a bare "100 pts" /
 *      "50 pts" Score row with no unit context, which in a multi-hundred-case
 *      comparison misreads as a CASE COUNT rather than a judge score.
 *   2. That whole bars block was redundant chrome for numbers (duration,
 *      tool calls) already visible elsewhere for the same case.
 *   3. "Show the numbers in the top header itself" instead of a chart.
 *
 * This renders exactly that: one small text line for the representative
 * case's Score / Duration / Tools, A vs B — using the SAME "Score: N%"
 * convention as {@link ../RunScore} (this app's canonical judge-score
 * presentation, `getRunOverallScore` mean-of-metrics as a 0-100 percentage)
 * so a `%` sign, not a bare number, carries the "this is a score, not a
 * count" signal. It renders as soon as both reports are known — independent
 * of the agentic deep-dive call (which can take 30-60s) — so the user isn't
 * stuck without these numbers until the LLM narrative finishes.
 */

import React from 'react';
import type { EvaluationReport } from '@/types';
import { getRunOverallScore } from '@/lib/utils';
import { formatDuration } from '@/services/metrics';

/** Shared "no data" placeholder — matches RunScore's missing-score dash. */
export const DEEPDIVE_METRIC_DASH = '\u2014';

/** `report.metrics` -> "N%" via the app's canonical score aggregate, or a dash. */
export function formatScoreCell(metrics: EvaluationReport['metrics'] | undefined | null): string {
  const score = getRunOverallScore(metrics);
  return score === null ? DEEPDIVE_METRIC_DASH : `${score}%`;
}

/** Wall-clock case duration -> "36.9s" (services/metrics formatDuration), or a dash. */
export function formatDurationCell(durationMs: number | undefined | null): string {
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? formatDuration(durationMs)
    : DEEPDIVE_METRIC_DASH;
}

/** Count of trajectory steps that are tool calls ('action'), or a dash when unknown. */
export function formatToolsCell(report: EvaluationReport | undefined | null): string {
  if (!report || !Array.isArray(report.trajectory)) return DEEPDIVE_METRIC_DASH;
  return String(report.trajectory.filter((s) => s?.type === 'action').length);
}

export interface DeepDiveHeaderMetricsProps {
  /** The representative test case's report for run A (the deep-dive's `pair.reportIdA`). */
  reportA?: EvaluationReport | null;
  /** The representative test case's report for run B (the deep-dive's `pair.reportIdB`). */
  reportB?: EvaluationReport | null;
}

/**
 * One compact line: "Score: 100% vs 50% · Duration: 36.9s vs 29.2s · Tools: 3 vs 3".
 * Renders nothing when neither report is known yet (nothing to show).
 */
export const DeepDiveHeaderMetrics: React.FC<DeepDiveHeaderMetricsProps> = ({ reportA, reportB }) => {
  if (!reportA && !reportB) return null;
  return (
    <p
      className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap"
      data-testid="deep-dive-header-metrics"
    >
      <span>
        Score:{' '}
        <span className="tabular-nums text-foreground/80">{formatScoreCell(reportA?.metrics)}</span>
        {' vs '}
        <span className="tabular-nums text-foreground/80">{formatScoreCell(reportB?.metrics)}</span>
      </span>
      <span aria-hidden="true" className="opacity-50">
        ·
      </span>
      <span>
        Duration:{' '}
        <span className="tabular-nums text-foreground/80">
          {formatDurationCell(reportA?.performanceMetrics?.durationMs)}
        </span>
        {' vs '}
        <span className="tabular-nums text-foreground/80">
          {formatDurationCell(reportB?.performanceMetrics?.durationMs)}
        </span>
      </span>
      <span aria-hidden="true" className="opacity-50">
        ·
      </span>
      <span>
        Tools:{' '}
        <span className="tabular-nums text-foreground/80">{formatToolsCell(reportA)}</span>
        {' vs '}
        <span className="tabular-nums text-foreground/80">{formatToolsCell(reportB)}</span>
      </span>
    </p>
  );
};
