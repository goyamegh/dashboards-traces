/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CaseTldrCard — the 3-sentence TL;DR shown above the Test Case Definition
 * in the run inspector: what the test asked → what the agent did → the
 * judgement and its main reason.
 *
 * Fetches `POST /api/storage/runs/:id/summary` lazily (the server caches the
 * model-written text on the report and regenerates it when the judgement
 * changes). While the request is in flight a skeleton is shown; the page is
 * never blocked. When the model is unavailable the server answers with a
 * deterministic field-based summary (`source: 'fallback'`) and the card says
 * so honestly instead of pretending it is an AI summary.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, ListChecks } from 'lucide-react';
import type { EvaluationReport, CaseSummary } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchCaseSummary } from '@/services/client/caseSummaryApi';
import type { ResultStatus } from './ResultStatus';

interface CaseTldrCardProps {
  report: EvaluationReport;
  status: ResultStatus;
  className?: string;
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: CaseSummary; cached: boolean }
  | { kind: 'error'; message: string };

/**
 * Everything on the report that, if it changes, must refetch the summary.
 * The SERVER decides freshness via its inputs hash; this key only makes the
 * client ask again when the judgement visibly changed (Retry judgement
 * reloads the report with a new `judgementRetriedAt`).
 */
function judgementKey(report: EvaluationReport): string {
  return [
    report.id,
    report.judgementRetriedAt ?? '',
    report.passFailStatus ?? '',
    report.metricsStatus ?? '',
    report.failureStage ?? '',
    (report.llmJudgeReasoning ?? '').length,
  ].join('|');
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  // "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5"
  const m = model.match(/claude-[a-z]+-\d+(?:-\d+)?/i) || model.match(/[^./:]+(?=[-:]\d{8})/);
  return m ? m[0] : model.split('/').pop();
}

export const CaseTldrCard: React.FC<CaseTldrCardProps> = ({ report, status, className }) => {
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const key = judgementKey(report);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ kind: 'loading' });
      try {
        const res = await fetchCaseSummary(report.id, { force, signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', summary: res.summary, cached: res.cached });
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: err?.message || 'Summary request failed' });
      }
    },
    // `key` folds in every judgement field we care about; report.id is part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  useEffect(() => {
    void load(false);
    return () => abortRef.current?.abort();
  }, [load]);

  const verdictTone =
    status === 'passed'
      ? 'text-green-700 dark:text-green-400'
      : status === 'failed'
        ? 'text-red-700 dark:text-red-400'
        : status === 'errored'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-foreground';

  return (
    <div
      className={`border-b bg-card/60 shrink-0 px-4 py-2.5 ${className || ''}`}
      data-testid="case-tldr"
      data-state={state.kind}
      data-source={state.kind === 'ready' ? state.summary.source : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">TL;DR</span>
        {state.kind === 'ready' && state.summary.source === 'llm' && (
          <Badge
            variant="secondary"
            className="text-[9px] px-1.5 py-0 gap-1 shrink-0"
            title={`Written by ${state.summary.model || 'the summary model'} · ${new Date(state.summary.generatedAt).toLocaleString()}`}
            data-testid="case-tldr-source"
          >
            <Sparkles size={9} /> AI summary{shortModel(state.summary.model) ? ` · ${shortModel(state.summary.model)}` : ''}
          </Badge>
        )}
        {state.kind === 'ready' && state.summary.source === 'fallback' && (
          <Badge
            variant="secondary"
            className="text-[9px] px-1.5 py-0 gap-1 shrink-0 bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30"
            title={state.summary.error ? `Auto summary unavailable: ${state.summary.error}` : 'Auto summary unavailable'}
            data-testid="case-tldr-source"
          >
            <ListChecks size={9} /> Field summary
          </Badge>
        )}
        <div className="flex-1" />
        {state.kind !== 'loading' && (
          <button
            type="button"
            onClick={() => void load(true)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Regenerate summary"
            aria-label="Regenerate summary"
            data-testid="case-tldr-regenerate"
          >
            <RefreshCw size={11} />
          </button>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="space-y-1.5" data-testid="case-tldr-skeleton" role="status" aria-label="Generating summary">
          <Skeleton className="h-3 w-[92%]" />
          <Skeleton className="h-3 w-[84%]" />
          <Skeleton className="h-3 w-[70%]" />
        </div>
      )}

      {state.kind === 'error' && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400" data-testid="case-tldr-error">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>Summary unavailable — {state.message}</span>
        </div>
      )}

      {state.kind === 'ready' && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-snug" data-testid="case-tldr-body">
          <dt className="text-muted-foreground font-medium">Asked</dt>
          <dd data-testid="case-tldr-asked">{state.summary.parts.asked}</dd>
          <dt className="text-muted-foreground font-medium">Agent</dt>
          <dd data-testid="case-tldr-agent">{state.summary.parts.agent}</dd>
          <dt className="text-muted-foreground font-medium">Verdict</dt>
          <dd className={`font-medium ${verdictTone}`} data-testid="case-tldr-verdict">{state.summary.parts.verdict}</dd>
          {state.summary.source === 'fallback' && (
            <dd className="col-span-2 text-[10px] text-muted-foreground italic" data-testid="case-tldr-fallback-note">
              Auto summary unavailable{state.summary.error ? ` (${state.summary.error})` : ''} — showing a field-based summary.
            </dd>
          )}
        </dl>
      )}
    </div>
  );
};
