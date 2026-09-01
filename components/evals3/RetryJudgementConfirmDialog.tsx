/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RetryJudgementConfirmDialog — confirm dialog for "retry judgement on
 * this run's judge-failed cases" (e.g. trace timeouts, judge 400s,
 * "evaluator could not run"). Salvages the run at JUDGE COST ONLY: the
 * agent is never re-invoked, only POSTs
 * /api/storage/evaluation-runs/:id/retry-judgement and shows the
 * retried/succeeded/failed summary in place before the caller refreshes.
 */

import React, { useState } from 'react';
import { Loader2, RotateCw, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { EvaluationRun } from '@/types';
import { getModelName } from '@/lib/utils';
import { retryJudgement, RetryJudgementSummary } from '@/services/client';

export interface RetryJudgementConfirmDialogProps {
  /** The run to retry judgement on. Dialog renders nothing while this is null. */
  run: EvaluationRun | null;
  /** Number of judge-failed cases eligible for retry (shown in the confirm copy). */
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the user dismisses a completed summary, so the caller can refresh. */
  onComplete: (summary: RetryJudgementSummary) => void;
}

export const RetryJudgementConfirmDialog: React.FC<RetryJudgementConfirmDialogProps> = ({
  run, count, open, onOpenChange, onComplete,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RetryJudgementSummary | null>(null);
  // Populated once the POST returns 202 and while polling for completion —
  // see retryJudgement()'s onProgress in services/client/evaluationRunsApi.ts.
  // A 62-case run's judge pipeline can take 20-30+ minutes; this is the only
  // feedback the user gets that the confirm dialog is still doing something.
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // Don't let a stray click close mid-request
    if (!next) {
      setError(null);
      // Reset the summary view so the NEXT open starts fresh; the caller
      // already got a chance to react to it via onComplete when the user
      // clicked "Done" below.
      setSummary(null);
      setProgress(null);
    }
    onOpenChange(next);
  };

  if (!run) return null;

  const judgeSummary = run.judgeModelId ? getModelName(run.judgeModelId) : 'Default';

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    setProgress(null);
    try {
      const result = await retryJudgement(run.id, 'errored', (completed, total) => setProgress({ completed, total }));
      setSubmitting(false);
      setSummary(result);
    } catch (err: any) {
      setSubmitting(false);
      setError(err.message || 'Failed to retry judgement');
    }
  };

  const handleDone = () => {
    if (summary) onComplete(summary);
    setSummary(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="retry-judgement-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCw size={16} /> Retry judgement?
          </DialogTitle>
          {!summary && (
            <DialogDescription>
              Re-runs ONLY the judge for this run's judge-failed cases (trace
              timeouts, judge errors, "evaluator could not run") against
              their already-recorded agent output. The agent is not
              re-invoked.
            </DialogDescription>
          )}
        </DialogHeader>

        {!summary ? (
          <div className="space-y-2 text-sm">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div>
                <span className="text-muted-foreground">Judge-failed cases:</span>{' '}
                <span className="font-medium" data-testid="retry-judgement-count">{count}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Judge model:</span>{' '}
                <span className="font-medium">{judgeSummary}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Cases whose agent execution never actually completed are skipped automatically -- the retried count below may be lower than this.
              </div>
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span data-testid="retry-judgement-error">{error}</span>
              </div>
            )}
            {submitting && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="retry-judgement-progress">
                <Loader2 size={12} className="animate-spin" />
                <span>
                  {progress && progress.total > 0
                    ? `Retrying judgement... ${progress.completed}/${progress.total}`
                    : 'Starting retry judgement...'}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-summary">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Retried:</span>
                <span className="font-medium">{summary.retried}</span>
              </div>
              <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} />
                <span>{summary.succeeded} succeeded</span>
              </div>
              {summary.failed > 0 && (
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <XCircle size={13} />
                  <span>{summary.failed} still failed</span>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {!summary ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={submitting || count === 0} data-testid="retry-judgement-confirm-btn">
                {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCw size={14} className="mr-1" />}
                {submitting
                  ? (progress && progress.total > 0 ? `Retrying ${progress.completed}/${progress.total}...` : 'Retrying...')
                  : 'Retry judgement'}
              </Button>
            </>
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
