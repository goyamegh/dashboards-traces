/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline "judge kind · underlying LLM" label, shared by the runs list, the
 * run inspector header, the comparison scoreboard and the per-test-case run
 * list so every surface tells the same story about who judged a run.
 *
 * Reads `judgeModel` (the LLM that actually produced the verdict — see
 * lib/judgeIdentity) and falls back to `judgeModelId` for reports persisted
 * before it was recorded. For an agentic judge whose model was never
 * recorded, a muted hint says so — the provider name (`agent-trace-judge`)
 * is never presented as if it were a model.
 */

import React from 'react';
import { getJudgeModelDisplay } from '@/lib/utils';

export type JudgeIdentityLike = { judgeModel?: string | null; judgeModelId?: string | null; judgeProvider?: string | null };

export interface JudgeModelLabelProps {
  /** `judgeProvider: 'none'` (a code-SDK report/run that never called `judge()`) renders "No LLM judge · code assertions only". */
  run: JudgeIdentityLike | null | undefined;
  className?: string;
  'data-testid'?: string;
}

export const JudgeModelLabel: React.FC<JudgeModelLabelProps> = ({ run, className = '', ...rest }) => {
  const { label, detail, hint, title } = getJudgeModelDisplay(run);
  return (
    <span className={`inline-flex items-baseline gap-1 min-w-0 ${className}`} title={title} data-testid={rest['data-testid'] ?? 'judge-model-label'}>
      <span className="truncate" data-testid="judge-model-kind">{label}</span>
      {detail && (
        <span className="text-muted-foreground font-mono text-[0.9em] truncate" data-testid="judge-model-resolved">
          · {detail}
        </span>
      )}
      {hint && (
        <span className="text-muted-foreground/70 italic text-[0.85em] truncate" data-testid="judge-model-not-recorded">
          · {hint}
        </span>
      )}
    </span>
  );
};

/** Plain-text form of the same label (for `title=` attributes and sort keys). */
export function judgeModelText(run: JudgeIdentityLike | null | undefined): string {
  const { label, detail, hint } = getJudgeModelDisplay(run);
  if (detail) return `${label} · ${detail}`;
  // "No LLM judge · code assertions only" -- the hint IS the information here.
  if (hint && label === 'No LLM judge') return `${label} · ${hint}`;
  return label;
}
