/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Variant 2 — margin notes: select → "Ask" → a note pinned in the right margin
 * (doc-comment style) holds the question + answer. All notes for THIS page are
 * listed (live threads first, then persisted ask sessions for the route), so
 * the margin doubles as "comments on any page".
 */

import React, { useEffect, useState } from 'react';
import { X, MessageSquareText } from 'lucide-react';
import { listAskSessions, type AskSessionSummary } from '@/services/client/askApi';
import type { AskThread } from './askState';
import { AskComposer, SelectionQuote, TurnView, suggestionsFor } from './AskShared';

export const MARGIN_WIDTH = 360;

export interface AskMarginProps {
  route: string;
  threads: AskThread[];
  /** Thread awaiting its first question (just created from a selection). */
  draftThreadId: string | null;
  onAsk: (threadId: string, question: string) => void;
  onCancel: (threadId: string) => void;
  onDismiss: (threadId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

export const AskMargin: React.FC<AskMarginProps> = ({ route, threads, draftThreadId, onAsk, onCancel, onDismiss, onOpenSession }) => {
  const [persisted, setPersisted] = useState<AskSessionSummary[]>([]);
  const liveSessionIds = new Set(threads.map((t) => t.sessionId).filter(Boolean));
  const doneCount = threads.filter((t) => t.turns.some((x) => x.status === 'done')).length;

  useEffect(() => {
    let cancelled = false;
    listAskSessions({ route, limit: 50 })
      .then((s) => { if (!cancelled) setPersisted(s); })
      .catch(() => { /* margin still shows live notes */ });
    return () => { cancelled = true; };
  }, [route, doneCount]);

  const older = persisted.filter((s) => !liveSessionIds.has(s.id));

  return (
    <aside
      data-ask-ui
      data-testid="ask-margin"
      style={{ width: MARGIN_WIDTH }}
      className="fixed right-0 top-0 bottom-0 z-40 border-l bg-background/95 backdrop-blur overflow-y-auto px-3 py-3 space-y-3"
      aria-label="Notes for this page"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold flex items-center gap-1"><MessageSquareText size={13} /> Notes on this page</h3>
        <span className="text-[10px] text-muted-foreground">{threads.length + older.length} note{threads.length + older.length === 1 ? '' : 's'}</span>
      </div>
      {threads.length === 0 && older.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="ask-margin-empty">Highlight any text on the page and click <b>Ask</b> to pin a note here.</p>
      ) : null}
      {threads.map((thread) => {
        const busy = thread.turns.some((t) => t.status === 'streaming');
        const isDraft = thread.id === draftThreadId && thread.turns.length === 0;
        return (
          <div key={thread.id} className="rounded-lg border bg-card shadow-sm p-2 space-y-2" data-testid="ask-note" data-draft={isDraft || undefined}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 space-y-1">{thread.selections.map((s) => <SelectionQuote key={s.text} selection={s} compact />)}</div>
              <button type="button" aria-label="Dismiss note" onClick={() => onDismiss(thread.id)} className="rounded p-0.5 hover:bg-accent"><X size={12} /></button>
            </div>
            {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} thread={thread} />)}
            <AskComposer
              autoFocus={isDraft}
              busy={busy}
              onSubmit={(q) => onAsk(thread.id, q)}
              onCancel={() => onCancel(thread.id)}
              placeholder={thread.turns.length ? 'Follow up…' : 'Ask about this…'}
              suggestions={thread.turns.length ? undefined : suggestionsFor(route, true)}
              testId="ask-note-composer"
            />
          </div>
        );
      })}
      {older.length ? (
        <div className="space-y-2" data-testid="ask-margin-history">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground pt-2">Earlier notes</div>
          {older.map((s) => (
            <button key={s.id} type="button" onClick={() => onOpenSession(s.id)} className="w-full text-left rounded-lg border p-2 hover:bg-accent space-y-1" data-testid="ask-margin-history-item">
              {s.firstSelection ? <div className="text-[11px] text-muted-foreground line-clamp-2 border-l-2 border-amber-300 pl-1">{s.firstSelection}</div> : null}
              <div className="text-xs font-medium line-clamp-2">{s.firstQuestion}</div>
              <div className="text-[11px] text-muted-foreground line-clamp-2">{s.lastAnswerPreview}</div>
              <div className="text-[10px] text-muted-foreground">{new Date(s.updatedAt).toLocaleString()} · {s.agentName}</div>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
};
