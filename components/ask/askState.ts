/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared state + hooks for "highlight & ask" (prototype).
 *
 * - `useAskVariant`: which UI variant is active. Chosen with `?ask=popover|margin|panel`
 *   (sticky via localStorage so navigation keeps it); `?ask=off` disables.
 * - `useTextSelection`: watches the document for a non-empty text selection
 *   outside the ask UI and reports its text, surrounding text and rect.
 * - `useAskThreads`: the thread/turn state machine that streams `/api/ask`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { streamAsk, type AskPageContext, type AskSelection } from '@/services/client/askApi';

export type AskVariant = 'popover' | 'margin' | 'panel' | 'off';
export const ASK_VARIANTS: AskVariant[] = ['popover', 'margin', 'panel'];
const VARIANT_KEY = 'ah.ask.variant';

export function readStoredVariant(): AskVariant | null {
  try {
    const v = window.localStorage.getItem(VARIANT_KEY);
    return v && (ASK_VARIANTS as string[]).includes(v) ? (v as AskVariant) : v === 'off' ? 'off' : null;
  } catch {
    return null;
  }
}

export function useAskVariant(): [AskVariant, (v: AskVariant) => void] {
  const location = useLocation();
  const fromUrl = useMemo(() => {
    const v = new URLSearchParams(location.search).get('ask');
    return v && ((ASK_VARIANTS as string[]).includes(v) || v === 'off') ? (v as AskVariant) : null;
  }, [location.search]);
  const [variant, setVariantState] = useState<AskVariant>(() => fromUrl ?? readStoredVariant() ?? 'popover');
  useEffect(() => {
    if (fromUrl && fromUrl !== variant) setVariantState(fromUrl);
    if (fromUrl) { try { window.localStorage.setItem(VARIANT_KEY, fromUrl); } catch { /* ignore */ } }
  }, [fromUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const setVariant = useCallback((v: AskVariant) => {
    setVariantState(v);
    try { window.localStorage.setItem(VARIANT_KEY, v); } catch { /* ignore */ }
  }, []);
  return [variant, setVariant];
}

// ----------------------------------------------------------------------------

export interface PendingSelection extends AskSelection {
  rect: { top: number; left: number; bottom: number; right: number; width: number; height: number };
}

const MIN_SELECTION_CHARS = 2;
const NEARBY_CAP = 600;

function nearbyTextFor(range: Range): string | undefined {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  let el = node as HTMLElement | null;
  // Walk up to a block-ish container that has some text but not the whole page.
  for (let i = 0; el && i < 6; i++) {
    const text = el.innerText?.trim() ?? '';
    if (text.length >= 40 || /^(P|LI|TD|TH|PRE|DIV|SECTION|ARTICLE|H[1-6])$/.test(el.tagName)) {
      if (text.length > 0) return text.slice(0, NEARBY_CAP);
    }
    el = el.parentElement;
  }
  return undefined;
}

/**
 * Report the current text selection (outside `[data-ask-ui]`) after the user
 * finishes selecting. Returns `null` while nothing is selected. `enabled=false`
 * turns the listener off (variant `off`).
 */
export function useTextSelection(enabled: boolean): [PendingSelection | null, () => void] {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const clear = useCallback(() => setPending(null), []);

  useEffect(() => {
    if (!enabled) { setPending(null); return; }
    const capture = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().replace(/\s+\n/g, '\n').trim();
      if (text.length < MIN_SELECTION_CHARS) return;
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
      if (anchorEl?.closest('[data-ask-ui]')) return;
      if (anchorEl?.closest('input, textarea')) return;
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      setPending({
        text,
        nearbyText: nearbyTextFor(range),
        rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
      });
    };
    const onMouseUp = () => setTimeout(capture, 0);
    const onKeyUp = (e: KeyboardEvent) => { if (e.shiftKey || e.key === 'Shift') setTimeout(capture, 0); };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-ask-ui]')) return;
      // A new click outside the ask UI dismisses the chip (a new selection re-shows it).
      setPending(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [enabled]);

  return [pending, clear];
}

// ----------------------------------------------------------------------------

export interface AskTurnState {
  id: string;
  question: string;
  answer: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  tools: Array<{ name: string; status: 'start' | 'end'; isError?: boolean }>;
  firstTokenMs?: number;
  durationMs?: number;
  startedAt: number;
}

export interface AskThread {
  /** Client id (stable before the server assigns a sessionId). */
  id: string;
  sessionId?: string;
  route: string;
  selections: AskSelection[];
  turns: AskTurnState[];
  agent?: { key: string; name: string; connectorType: string };
  loaded?: string[];
  refs?: Record<string, string | string[] | undefined>;
  createdAt: number;
}

let threadSeq = 0;
export function newThreadId(): string {
  threadSeq += 1;
  return `t-${Date.now().toString(36)}-${threadSeq}`;
}

export function buildPageContext(route: string): AskPageContext {
  // Breadcrumb trail (evals3 pages) > a page-level h1 that is not the app
  // brand > document.title. The sessions list groups by this.
  const crumbs = Array.from(document.querySelectorAll('nav[aria-label="Breadcrumb"] a, nav[aria-label="Breadcrumb"] span'))
    .map((e) => e.textContent?.trim() ?? '')
    .filter((t) => t && t !== '/' && t !== '›' && t !== '>' && t.length < 80);
  const h1 = Array.from(document.querySelectorAll('h1')).map((e) => e.textContent?.trim() ?? '').find((t) => t && !/AgentHealth|Agent Health/i.test(t));
  const title = crumbs.length ? Array.from(new Set(crumbs)).join(' › ') : h1 || document.title;
  return { route, title };
}

export function useAskThreads(variant: AskVariant) {
  const [threads, setThreads] = useState<Record<string, AskThread>>({});
  const aborters = useRef<Record<string, AbortController>>({});
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const update = useCallback((id: string, fn: (t: AskThread) => AskThread) => {
    setThreads((prev) => (prev[id] ? { ...prev, [id]: fn(prev[id]) } : prev));
  }, []);

  const createThread = useCallback((route: string, selections: AskSelection[]): AskThread => {
    const t: AskThread = { id: newThreadId(), route, selections, turns: [], createdAt: Date.now() };
    threadsRef.current = { ...threadsRef.current, [t.id]: t }; // visible to ask() in the same tick
    setThreads((prev) => ({ ...prev, [t.id]: t }));
    return t;
  }, []);

  const addSelection = useCallback((threadId: string, sel: AskSelection) => {
    update(threadId, (t) => (t.selections.some((s) => s.text === sel.text) ? t : { ...t, selections: [...t.selections, sel] }));
  }, [update]);

  const removeSelection = useCallback((threadId: string, text: string) => {
    update(threadId, (t) => ({ ...t, selections: t.selections.filter((s) => s.text !== text) }));
  }, [update]);

  const removeThread = useCallback((threadId: string) => {
    aborters.current[threadId]?.abort();
    setThreads((prev) => { const n = { ...prev }; delete n[threadId]; return n; });
  }, []);

  /** Import a persisted session as a thread (sessions list → open). */
  const importSession = useCallback((s: { id: string; page: AskPageContext; selections: AskSelection[]; turns: Array<{ id: string; question: string; answer: string; error?: string; toolCalls: string[]; firstTokenMs?: number; durationMs?: number; startedAt: string }>; agentKey: string; agentName: string }) => {
    const t: AskThread = {
      id: `s-${s.id}`,
      sessionId: s.id,
      route: s.page.route,
      selections: s.selections,
      agent: { key: s.agentKey, name: s.agentName, connectorType: '' },
      createdAt: Date.now(),
      turns: s.turns.map((turn) => ({
        id: turn.id,
        question: turn.question,
        answer: turn.answer,
        status: turn.error ? 'error' : 'done',
        error: turn.error,
        tools: (turn.toolCalls ?? []).map((name) => ({ name, status: 'end' as const })),
        firstTokenMs: turn.firstTokenMs,
        durationMs: turn.durationMs,
        startedAt: Date.parse(turn.startedAt) || Date.now(),
      })),
    };
    setThreads((prev) => ({ ...prev, [t.id]: t }));
    return t;
  }, []);

  const ask = useCallback(async (threadId: string, question: string, opts: { agentKey?: string; selections?: AskSelection[] } = {}) => {
    const thread = threadsRef.current[threadId];
    if (!thread) return;
    const turnId = `turn-${Date.now().toString(36)}`;
    const turn: AskTurnState = { id: turnId, question, answer: '', status: 'streaming', tools: [], startedAt: Date.now() };
    update(threadId, (t) => ({ ...t, turns: [...t.turns, turn] }));

    const controller = new AbortController();
    aborters.current[threadId] = controller;
    const sendSelections = opts.selections ?? (thread.turns.length === 0 ? thread.selections : []);
    try {
      const done = await streamAsk(
        {
          question,
          selections: sendSelections,
          pageContext: buildPageContext(thread.route),
          agentKey: opts.agentKey,
          sessionId: thread.sessionId,
          variant,
        },
        {
          onMeta: (meta) => update(threadId, (t) => ({ ...t, sessionId: meta.sessionId, agent: meta.agent, loaded: meta.loaded, refs: meta.refs })),
          onDelta: (text) => update(threadId, (t) => ({
            ...t,
            turns: t.turns.map((x) => (x.id === turnId ? { ...x, answer: x.answer + text } : x)),
          })),
          onTool: (tool) => update(threadId, (t) => ({
            ...t,
            turns: t.turns.map((x) => (x.id === turnId ? { ...x, tools: [...x.tools.filter((y) => !(y.name === tool.name && y.status === 'start' && tool.status === 'end')), { name: tool.name, status: tool.status, isError: tool.isError }] } : x)),
          })),
        },
        controller.signal
      );
      update(threadId, (t) => ({
        ...t,
        turns: t.turns.map((x) => (x.id === turnId ? { ...x, answer: done.answer, status: 'done', firstTokenMs: done.firstTokenMs, durationMs: done.durationMs } : x)),
      }));
    } catch (err: any) {
      if (controller.signal.aborted) {
        update(threadId, (t) => ({ ...t, turns: t.turns.map((x) => (x.id === turnId ? { ...x, status: 'error', error: 'Cancelled' } : x)) }));
      } else {
        update(threadId, (t) => ({ ...t, turns: t.turns.map((x) => (x.id === turnId ? { ...x, status: 'error', error: err?.message ?? String(err) } : x)) }));
      }
    } finally {
      delete aborters.current[threadId];
    }
  }, [update, variant]);

  const cancel = useCallback((threadId: string) => aborters.current[threadId]?.abort(), []);

  return { threads, createThread, addSelection, removeSelection, removeThread, importSession, ask, cancel };
}
