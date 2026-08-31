/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DeepDiveHeaderMetrics — the ComparisonDeepDive ("What's actually
 * different") panel's header: WHICH test case this is about, plus a
 * compact single-line A-vs-B numbers row.
 *
 * Owner feedback on the deep-dive panel (screenshot-verified):
 *   1. The panel's "Performance & Outcome" bars showed a bare "100 pts" /
 *      "50 pts" Score row with no unit context, which in a multi-hundred-case
 *      comparison misreads as a CASE COUNT rather than a judge score.
 *   2. That whole bars block was redundant chrome for numbers (duration,
 *      tool calls) already visible elsewhere for the same case.
 *   3. "Show the numbers in the top header itself" instead of a chart.
 *   4. Follow-up: the panel is PER-CASE (it picks ONE representative test
 *      case both runs executed) but nothing in the header said so — prose
 *      like "Run A passed (100/100)" reads like a run-level pass-rate stat
 *      ("not every test passed in the benchmark") even though it's one
 *      case's judge score. Fix: name the case, prominently, right here —
 *      see `testCaseName`/`testCaseId` below — so "Case: <name>" is the
 *      first thing read, before any score.
 *
 * The metrics line uses the SAME "Score: N%" convention as
 * {@link ../RunScore} (this app's canonical judge-score presentation,
 * `getRunOverallScore` mean-of-metrics as a 0-100 percentage) so a `%` sign,
 * not a bare number, carries the "this is a score, not a count" signal. It
 * renders as soon as both reports are known — independent of the agentic
 * deep-dive call (which can take 30-60s) — so the user isn't stuck without
 * these numbers until the LLM narrative finishes.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
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
  /** Name of the ONE test case this deep-dive is analyzing (the panel is per-case, not per-run). */
  testCaseName?: string | null;
  /** Id of that test case, for the "view full case" link. Renders as plain text when absent. */
  testCaseId?: string | null;
}

/**
 * Case identity line ("Case: <name>", linked) followed by one compact line:
 * "Score: 100% vs 50% · Duration: 36.9s vs 29.2s · Tools: 3 vs 3".
 * Renders nothing when there is neither a case name nor any report to show.
 */
export const DeepDiveHeaderMetrics: React.FC<DeepDiveHeaderMetricsProps> = ({
  reportA,
  reportB,
  testCaseName,
  testCaseId,
}) => {
  if (!reportA && !reportB && !testCaseName) return null;
  return (
    <>
      {testCaseName && (
        <p
          className="text-xs font-medium text-foreground/90 flex items-center gap-1 mt-0.5 min-w-0"
          data-testid="deep-dive-case-label"
        >
          <span className="text-muted-foreground font-normal flex-shrink-0">Case:</span>
          {testCaseId ? (
            <Link
              to={`/evaluations/test-cases/${testCaseId}`}
              className="truncate text-opensearch-blue hover:underline inline-flex items-center gap-1 min-w-0"
            >
              <span className="truncate">{testCaseName}</span>
              <ExternalLink size={11} className="flex-shrink-0" />
            </Link>
          ) : (
            <span className="truncate">{testCaseName}</span>
          )}
        </p>
      )}
      {(reportA || reportB) && (
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
      )}
    </>
  );
};
