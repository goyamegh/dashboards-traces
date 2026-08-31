/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RerunConfirmDialog — shared confirm dialog for "kick off a duplicate of
 * this run". Used from both the run report page header
 * (EvalRunDetailPage) and the evaluation-runs list's row action
 * (EvalRunsPage). Shows a name preview + agent/judge summary, then POSTs
 * /api/storage/evaluation-runs/:id/rerun and hands the new run id back to
 * the caller (which navigates to its report page).
 */

import React, { useState } from 'react';
import { Loader2, RotateCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { EvaluationRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getModelName } from '@/lib/utils';
import { computeRerunName } from '@/lib/evaluationRerun';
import { rerunEvaluationRun } from '@/services/client';

export interface RerunConfirmDialogProps {
  /** The source run to duplicate. Dialog renders nothing while this is null. */
  run: EvaluationRun | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the newly-created run's id once the POST succeeds. */
  onRerun: (newRunId: string) => void;
}

export const RerunConfirmDialog: React.FC<RerunConfirmDialogProps> = ({ run, open, onOpenChange, onRerun }) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // Don't let a stray click close mid-request
    if (!next) setError(null);
    onOpenChange(next);
  };

  if (!run) return null;

  const previewName = computeRerunName(run.name);
  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const judgeSummary = run.judgeModelId ? getModelName(run.judgeModelId) : 'Default';
  const testCaseCount = run.testCaseSnapshots?.length ?? 0;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await rerunEvaluationRun(run.id);
      setSubmitting(false);
      onOpenChange(false);
      onRerun(result.runId);
    } catch (err: any) {
      setSubmitting(false);
      setError(err.message || 'Failed to re-run evaluation run');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="rerun-confirm-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw size={16} /> Re-run evaluation?
          </DialogTitle>
          <DialogDescription>
            This creates a new, independent run using this run's configuration —
            agent, judge, and test-case sources are re-resolved at launch time,
            so results may differ if that configuration has changed since.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <div>
              <span className="text-muted-foreground">New run name:</span>{' '}
              <span className="font-medium" data-testid="rerun-name-preview">{previewName}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Agent:</span>{' '}
              <span className="font-medium">{agentName}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Judge:</span>{' '}
              <span className="font-medium">{judgeSummary}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Test cases:</span>{' '}
              <span className="font-medium">{testCaseCount}</span>
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span data-testid="rerun-error">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting} data-testid="rerun-confirm-btn">
            {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCcw size={14} className="mr-1" />}
            {submitting ? 'Starting...' : 'Re-run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
