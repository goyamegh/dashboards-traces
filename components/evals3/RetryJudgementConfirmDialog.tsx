/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RetryJudgementConfirmDialog — confirm dialog for "retry judgement on this
 * run" (judge-failed cases by default; the whole run for a deterministic
 * evaluator). Salvages the run at JUDGE COST ONLY: the agent is never
 * re-invoked.
 *
 * ASYNC (owner: "the retry button is not async in nature"): Confirm POSTs
 * .../retry-judgement and hands the 202 job to the client-side job store
 * (services/client/retryJudgementJobs.ts). From then on the dialog is just
 * another subscriber: it may be closed at once (Esc / X / Close) without
 * cancelling anything, the run's header + list row show a "Re-judging n/N…"
 * pill, the page toaster announces the summary, and re-opening the dialog
 * while the job runs shows the live progress instead of a fresh form.
 *
 * PRE-FLIGHT ("not evaluable" is not "failed"): on open the dialog asks
 * POST .../retry-judgement/preflight what a retry with the run's evaluator
 * would do. For a deterministic evaluator that is exact — "n of N cases
 * evaluable by this evaluator" with the not-evaluable reasons grouped — and
 * Confirm is disabled when n = 0 so an evaluator whose gold/extraction rules
 * fit none of the cases cannot be run into "0 succeeded · 3 still failed".
 * `evaluatorId` is a prop so an evaluator picker (PR #509) can drive the
 * same pre-flight; without one the run's own evaluator is pre-flighted.
 */

import React, { useEffect, useState } from 'react';
import { Loader2, RotateCw, AlertTriangle, CheckCircle2, XCircle, CircleSlash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { EvaluationRun } from '@/types';
import { getModelName } from '@/lib/utils';
import {
  groupNotEvaluableReasons,
  notEvaluableCount,
  preflightRetryJudgement,
  type RetryJudgementPreflight,
  type RetryJudgementSummary,
} from '@/services/client/evaluationRunsApi';
import { startRetryJudgementJob } from '@/services/client/retryJudgementJobs';
import { useRetryJudgementJob } from '@/hooks/useRetryJudgementJob';
import { NOT_EVALUABLE_HINT, formatRetryJudgementSummary } from './RetryJudgementJobs';
import { ScoringDiagnosticsView } from './ScoringDiagnosticsView';
import type { ScoringDiagnostics } from '@/types';

export interface RetryJudgementConfirmDialogProps {
  /** The run to retry judgement on. Dialog renders nothing while this is null. */
  run: EvaluationRun | null;
  /** Number of judge-failed cases eligible for retry (shown in the confirm copy). */
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the user dismisses a completed summary with "Done" (the
   * pages ALSO refresh via useOnRetryJudgementFinished, so this is optional
   * bookkeeping, not the only refresh path any more).
   */
  onComplete?: (summary: RetryJudgementSummary) => void;
  /** Evaluator to retry with (an evaluator picker's selection); absent → the run's own evaluator. */
  evaluatorId?: string;
}

/** Per-case rows ("<test case> — <reason>" + diagnostics) for not-evaluable / failed cases. */
export const CaseDiagnosticsList: React.FC<{
  cases: Array<{ testCaseId: string; reason?: string; error?: string; diagnostics?: ScoringDiagnostics }>;
  testId: string;
}> = ({ cases, testId }) => (
  <details className="text-[11px]" data-testid={testId}>
    <summary className="cursor-pointer text-muted-foreground">Per-case details ({cases.length})</summary>
    <ul className="mt-1 space-y-1.5 max-h-56 overflow-y-auto pr-1">
      {cases.map(c => (
        <li key={c.testCaseId} className="rounded border bg-background/60 p-1.5" data-testid={`${testId}-${c.testCaseId}`}>
          <div className="font-mono text-[10px] text-muted-foreground truncate" title={c.testCaseId}>{c.testCaseId}</div>
          <div>{c.reason ?? c.error ?? 'no reason recorded'}</div>
          {c.diagnostics && <ScoringDiagnosticsView diagnostics={c.diagnostics} className="mt-1 text-muted-foreground" />}
        </li>
      ))}
    </ul>
  </details>
);

/** "3 × no gold ids on the test case (…)" rows for a grouped reason map. */
export const NotEvaluableReasons: React.FC<{ reasons: Array<{ reason: string; count: number }>; testId: string }> = ({ reasons, testId }) => (
  <ul className="space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300" data-testid={testId}>
    {reasons.map(r => (
      <li key={r.reason} className="flex gap-1.5">
        <span className="shrink-0 tabular-nums font-medium">{r.count} ×</span>
        <span>{r.reason}</span>
      </li>
    ))}
  </ul>
);

export const RetryJudgementConfirmDialog: React.FC<RetryJudgementConfirmDialogProps> = ({
  run, count, open, onOpenChange, onComplete, evaluatorId,
}) => {
  const runId = run?.id;
  const job = useRetryJudgementJob(runId, run?.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<RetryJudgementPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // The job this dialog instance started or watched — the summary view shows
  // only for a job that finished while the dialog was open; a stale finished
  // job from an earlier open (already toasted) starts a fresh form.
  const [watchedStartedAt, setWatchedStartedAt] = useState<number | null>(null);

  // Pre-flight whenever the dialog opens or the evaluator selection changes.
  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);
    preflightRetryJudgement(runId, evaluatorId ? { evaluatorId } : {})
      .then(p => { if (!cancelled) setPreflight(p); })
      .catch(err => { if (!cancelled) setPreflightError(err?.message || 'Pre-flight failed'); });
    return () => { cancelled = true; };
  }, [open, runId, evaluatorId]);

  // Re-opened while the job runs → watch it (live progress instead of a form).
  useEffect(() => {
    if (open && job?.status === 'running') setWatchedStartedAt(job.startedAt);
  }, [open, job?.status, job?.startedAt]);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // the POST is in flight for a moment — don't lose its error
    if (!next) {
      setError(null);
      setWatchedStartedAt(null);
    }
    onOpenChange(next);
  };

  if (!run) return null;

  const judgeSummary = run.judgeModelId ? getModelName(run.judgeModelId) : 'Default';
  const watching = job && watchedStartedAt !== null && job.startedAt === watchedStartedAt ? job : undefined;
  const running = watching?.status === 'running';
  const summary = watching?.status === 'completed' ? watching.summary : undefined;
  const jobError = watching?.status === 'failed' ? watching.error : undefined;

  const deterministic = !!preflight?.deterministic;
  const nothingEvaluable = deterministic && (preflight?.evaluable ?? 0) === 0;
  const preflightReasons = preflight
    ? Object.entries(preflight.reasons).map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count)
    : [];
  const retryCount = preflight ? preflight.total : count;
  const confirmDisabled = submitting || running || retryCount === 0 || nothingEvaluable || (!preflight && !preflightError);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const started = await startRetryJudgementJob(
        run.id,
        { scope: deterministic ? 'all' : 'errored', ...(evaluatorId ? { evaluatorId } : {}) },
        run.name,
      );
      setWatchedStartedAt(started.startedAt);
    } catch (err: any) {
      setError(err.message || 'Failed to retry judgement');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDone = () => {
    if (summary) onComplete?.(summary);
    setWatchedStartedAt(null);
    onOpenChange(false);
  };

  const showForm = !running && !summary && !jobError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="retry-judgement-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCw size={16} /> Retry judgement?
          </DialogTitle>
          <DialogDescription>
            {showForm
              ? (deterministic
                ? 'Re-scores every case of this run in code with its deterministic evaluator against the already-recorded agent output. No judge model is called and the agent is not re-invoked.'
                : 'Re-runs ONLY the judge for this run\'s judge-failed cases (trace timeouts, judge errors, "evaluator could not run") against their already-recorded agent output. The agent is not re-invoked.')
              : running
                ? 'Retry judgement is running in the background.'
                : 'Retry judgement finished.'}
          </DialogDescription>
        </DialogHeader>

        {showForm && (
          <div className="space-y-2 text-sm">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div>
                <span className="text-muted-foreground">{deterministic ? 'Cases to re-score:' : 'Judge-failed cases:'}</span>{' '}
                <span className="font-medium" data-testid="retry-judgement-count">{retryCount}</span>
              </div>
              <div>
                <span className="text-muted-foreground">{deterministic ? 'Evaluator:' : 'Judge model:'}</span>{' '}
                <span className="font-medium">{deterministic ? (preflight?.evaluatorName || preflight?.evaluatorId) : judgeSummary}</span>
              </div>
              {!deterministic && (
                <div className="text-xs text-muted-foreground">
                  Cases whose agent execution never actually completed are skipped automatically -- the retried count below may be lower than this.
                </div>
              )}
            </div>

            {/* Pre-flight */}
            {!preflight && !preflightError && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="retry-judgement-preflight-loading">
                <Loader2 size={12} className="animate-spin" /> Checking which cases this evaluator can score…
              </div>
            )}
            {preflightError && (
              <div className="text-xs text-muted-foreground" data-testid="retry-judgement-preflight-error">
                Could not pre-flight this retry ({preflightError}); you can still start it.
              </div>
            )}
            {preflight?.deterministic && (
              <div
                data-testid="retry-judgement-preflight"
                data-evaluable={preflight.evaluable}
                className={`rounded-md border p-2 text-xs space-y-1 ${nothingEvaluable
                  ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
                  : 'bg-muted/30'}`}
              >
                <div className="flex items-center gap-1.5">
                  {nothingEvaluable ? <CircleSlash size={13} className="shrink-0" /> : <CheckCircle2 size={13} className="shrink-0 text-green-600 dark:text-green-400" />}
                  <span data-testid="retry-judgement-preflight-summary">
                    <span className="font-medium">{preflight.evaluable} of {preflight.total}</span> case{preflight.total === 1 ? '' : 's'} evaluable by this evaluator
                  </span>
                </div>
                {preflight.abstain > 0 && (
                  <div className="text-[11px] text-muted-foreground" data-testid="retry-judgement-preflight-abstain">
                    {preflight.abstain} abstain case{preflight.abstain === 1 ? '' : 's'} (gold explicitly empty — judged by whether the agent returned nothing)
                  </div>
                )}
                {preflightReasons.length > 0 && <NotEvaluableReasons reasons={preflightReasons} testId="retry-judgement-preflight-reasons" />}
                {preflight.cases.some(c => !c.evaluable) && (
                  <CaseDiagnosticsList cases={preflight.cases.filter(c => !c.evaluable)} testId="retry-judgement-preflight-cases" />
                )}
                {nothingEvaluable && <div className="text-[11px]">{NOT_EVALUABLE_HINT}</div>}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span data-testid="retry-judgement-error">{error}</span>
              </div>
            )}
          </div>
        )}

        {running && watching && (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-progress">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              <span data-testid="retry-judgement-progress-text">
                {watching.total > 0
                  ? `Re-judging ${watching.completed}/${watching.total}…`
                  : 'Starting retry judgement…'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              This runs in the background — you can close this dialog and keep working. The run refreshes when it finishes.
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-summary">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="font-medium" data-testid="retry-judgement-summary-line">{formatRetryJudgementSummary(summary)}</div>
              <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} />
                <span>{summary.succeeded} scored</span>
              </div>
              {notEvaluableCount(summary) > 0 && (
                <div className="space-y-1 text-amber-600 dark:text-amber-400" data-testid="retry-judgement-summary-not-evaluable">
                  <div className="flex items-center gap-1.5">
                    <CircleSlash size={13} />
                    <span>{notEvaluableCount(summary)} not evaluable</span>
                  </div>
                  <NotEvaluableReasons reasons={groupNotEvaluableReasons(summary.results)} testId="retry-judgement-summary-reasons" />
                  <CaseDiagnosticsList cases={summary.results.filter(r => r.outcome === 'not-evaluable')} testId="retry-judgement-summary-cases" />
                  <div className="text-[11px]">{NOT_EVALUABLE_HINT}</div>
                </div>
              )}
              {summary.failed > 0 && (
                <div className="space-y-1 text-red-600 dark:text-red-400">
                  <div className="flex items-center gap-1.5">
                    <XCircle size={13} />
                    <span>{summary.failed} failed (judgement could not be made)</span>
                  </div>
                  <CaseDiagnosticsList cases={summary.results.filter(r => r.outcome === 'failed')} testId="retry-judgement-summary-failed-cases" />
                </div>
              )}
            </div>
          </div>
        )}

        {jobError && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span data-testid="retry-judgement-error">{jobError}</span>
          </div>
        )}

        <DialogFooter>
          {showForm ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={confirmDisabled}
                data-testid="retry-judgement-confirm-btn"
                title={nothingEvaluable ? 'This evaluator cannot score any case of this run' : undefined}
              >
                {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCw size={14} className="mr-1" />}
                {submitting ? 'Starting…' : 'Retry judgement'}
              </Button>
            </>
          ) : running ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)} data-testid="retry-judgement-close-btn">
              Close — keep running
            </Button>
          ) : (
            <Button onClick={handleDone} data-testid="retry-judgement-done-btn">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
