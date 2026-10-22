/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared state + hooks for the Agent Health assistant ("highlight & ask").
 *
 * - `useTextSelection`: watches the document for a non-empty text selection
 *   outside the ask UI and reports its text, surrounding text and rect.
 * - `useAskThreads`: the thread/turn state machine that prepares and streams
 *   `/api/ask`. Threads are pi sessions on the server; `sessionId` is the pi
 *   session id.
 * - `usePersistedWidth`: the resizable panel's width (localStorage).
 * - `openAskPanel()` / `onOpenAskPanel()`: a tiny event bus so the sidebar
 *   entry, the nudge and the `/assistant` route can open the panel from
 *   anywhere without threading props through Layout.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAskStatus, prepareAsk, streamAsk, type AskPageContext, type AskSelection, type AskStatus } from '@/services/client/askApi';

// ----------------------------------------------------------------------------
// Server-side status (enabled flag, where history lives). Fetched once.
// ----------------------------------------------------------------------------

export function useAskStatus(): AskStatus | null {
  const [status, setStatus] = useState<AskStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAskStatus().then((s) => { if (!cancelled) setStatus(s); }).catch(() => { /* treat as enabled; the first ask surfaces the real error */ });
    return () => { cancelled = true; };
  }, []);
  return status;
}

// ----------------------------------------------------------------------------
// Open-panel event bus
// ----------------------------------------------------------------------------

const OPEN_EVENT = 'agent-health:ask-open';
export function openAskPanel(detail: { question?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
}
export function onOpenAskPanel(handler: (detail: { question?: string }) => void): () => void {
  const l = (e: Event) => handler((e as CustomEvent).detail ?? {});
  window.addEventListener(OPEN_EVENT, l);
  return () => window.removeEventListener(OPEN_EVENT, l);
}

// ----------------------------------------------------------------------------
// Selection
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
  for (let i = 0; el && i < 6; i++) {
    const text = el.innerText?.trim() ?? '';
    if (text.length >= 40 || /^(P|LI|TD|TH|PRE|DIV|SECTION|ARTICLE|H[1-6])$/.test(el.tagName)) {
      if (text.length > 0) return text.slice(0, NEARBY_CAP);
    }
    el = el.parentElement;
  }
  return undefined;
}

/** Report the current text selection (outside `[data-ask-ui]`) after the user finishes selecting. */
export function useTextSelection(): [PendingSelection | null, () => void] {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const clear = useCallback(() => setPending(null), []);

  useEffect(() => {
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
  }, []);

  return [pending, clear];
}

// ----------------------------------------------------------------------------
// Threads
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
  /** pi session id (from prepare or the first answer). */
  sessionId?: string;
  route: string;
  selections: AskSelection[];
  turns: AskTurnState[];
  model?: string;
  loaded?: string[];
  refs?: Record<string, string | string[] | undefined>;
  createdAt: number;
  /** Snapshot + pi session are being / have been built server-side for the first question. */
  preparing?: boolean;
  prepared?: boolean;
}

let threadSeq = 0;
export function newThreadId(): string {
  threadSeq += 1;
  return `t-${Date.now().toString(36)}-${threadSeq}`;
}

export function buildPageContext(route: string): AskPageContext {
  // Breadcrumb trail (evals3 pages) > a page-level h1 that is not the app brand > document.title.
  const crumbs = Array.from(document.querySelectorAll('nav[aria-label="Breadcrumb"] a, nav[aria-label="Breadcrumb"] span'))
    .map((e) => e.textContent?.trim() ?? '')
    .filter((t) => t && t !== '/' && t !== '›' && t !== '>' && t.length < 80);
  const h1 = Array.from(document.querySelectorAll('h1')).map((e) => e.textContent?.trim() ?? '').find((t) => t && !/AgentHealth|Agent Health/i.test(t));
  const title = crumbs.length ? Array.from(new Set(crumbs)).join(' › ') : h1 || document.title;
  return { route, title };
}

export function useAskThreads() {
  const [threads, setThreads] = useState<Record<string, AskThread>>({});
  const aborters = useRef<Record<string, AbortController>>({});
  const prepares = useRef<Record<string, Promise<void>>>({});
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const update = useCallback((id: string, fn: (t: AskThread) => AskThread) => {
    setThreads((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev, [id]: fn(prev[id]) };
      threadsRef.current = next;
      return next;
    });
  }, []);

  /** Build the snapshot + pi session now so the first answer starts faster. */
  const prepare = useCallback((threadId: string) => {
    const t = threadsRef.current[threadId];
    if (!t || t.sessionId || t.preparing) return;
    update(threadId, (x) => ({ ...x, preparing: true }));
    prepares.current[threadId] = prepareAsk({ pageContext: buildPageContext(t.route), selections: t.selections })
      .then((p) => update(threadId, (x) => (x.sessionId ? x : { ...x, sessionId: p.sessionId, refs: p.refs, loaded: p.loaded, model: p.model, prepared: true, preparing: false })))
      .catch(() => update(threadId, (x) => ({ ...x, preparing: false }))) // ask() will prepare on demand
      .finally(() => { delete prepares.current[threadId]; });
  }, [update]);

  const createThread = useCallback((route: string, selections: AskSelection[], opts: { prepare?: boolean } = {}): AskThread => {
    const t: AskThread = { id: newThreadId(), route, selections, turns: [], createdAt: Date.now() };
    threadsRef.current = { ...threadsRef.current, [t.id]: t };
    setThreads((prev) => ({ ...prev, [t.id]: t }));
    if (opts.prepare) setTimeout(() => prepare(t.id), 0);
    return t;
  }, [prepare]);

  const addSelection = useCallback((threadId: string, sel: AskSelection) => {
    update(threadId, (t) => (t.selections.some((s) => s.text === sel.text) ? t : { ...t, selections: [...t.selections, sel] }));
  }, [update]);

  const removeSelection = useCallback((threadId: string, text: string) => {
    update(threadId, (t) => ({ ...t, selections: t.selections.filter((s) => s.text !== text) }));
  }, [update]);

  const removeThread = useCallback((threadId: string) => {
    aborters.current[threadId]?.abort();
    setThreads((prev) => { const n = { ...prev }; delete n[threadId]; threadsRef.current = n; return n; });
  }, []);

  /** Import a persisted pi session as a thread (sessions list → open). */
  const importSession = useCallback((s: { id: string; page: AskPageContext; selections: AskSelection[]; model?: string; turns: Array<{ id: string; question: string; answer: string; error?: string; toolCalls: string[]; firstTokenMs?: number; durationMs?: number; startedAt: string }> }) => {
    const existing = Object.values(threadsRef.current).find((t) => t.sessionId === s.id);
    if (existing) return existing;
    const t: AskThread = {
      id: `s-${s.id}`,
      sessionId: s.id,
      route: s.page.route,
      selections: s.selections,
      model: s.model,
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
    threadsRef.current = { ...threadsRef.current, [t.id]: t };
    setThreads((prev) => ({ ...prev, [t.id]: t }));
    return t;
  }, []);

  const ask = useCallback(async (threadId: string, question: string) => {
    if (!threadsRef.current[threadId]) return;
    const isFirstTurn = threadsRef.current[threadId].turns.length === 0;
    const turnId = `turn-${Date.now().toString(36)}`;
    const turn: AskTurnState = { id: turnId, question, answer: '', status: 'streaming', tools: [], startedAt: Date.now() };
    update(threadId, (t) => ({ ...t, turns: [...t.turns, turn] }));
    // A prepare fired on chip click may still be in flight when the user hits
    // Enter; wait for it so the question joins THAT pi session instead of
    // making the server build a second snapshot.
    if (prepares.current[threadId]) await prepares.current[threadId];
    const thread = threadsRef.current[threadId];
    if (!thread) return;

    const controller = new AbortController();
    aborters.current[threadId] = controller;
    // The first turn carries the highlighted text (prepare() only used it for the snapshot); follow-ups add none.
    const sendSelections = isFirstTurn ? thread.selections : [];
    const patchTurn = (fn: (x: AskTurnState) => AskTurnState) =>
      update(threadId, (t) => ({ ...t, turns: t.turns.map((x) => (x.id === turnId ? fn(x) : x)) }));
    try {
      const done = await streamAsk(
        { question, selections: sendSelections, pageContext: buildPageContext(thread.route), sessionId: thread.sessionId },
        {
          onMeta: (meta) => update(threadId, (t) => ({ ...t, sessionId: meta.sessionId, model: meta.agent.model, loaded: meta.loaded.length ? meta.loaded : t.loaded, refs: meta.refs })),
          onDelta: (text) => patchTurn((x) => ({ ...x, answer: x.answer + text })),
          onTool: (tool) => patchTurn((x) => ({
            ...x,
            tools: [...x.tools.filter((y) => !(y.name === tool.name && y.status === 'start' && tool.status === 'end')), { name: tool.name, status: tool.status, isError: tool.isError }],
          })),
        },
        controller.signal
      );
      patchTurn((x) => ({ ...x, answer: done.answer, status: 'done', firstTokenMs: done.firstTokenMs, durationMs: done.durationMs }));
    } catch (err: any) {
      patchTurn((x) => ({ ...x, status: 'error', error: controller.signal.aborted ? 'Cancelled' : err?.message ?? String(err) }));
    } finally {
      delete aborters.current[threadId];
    }
  }, [update]);

  const cancel = useCallback((threadId: string) => aborters.current[threadId]?.abort(), []);

  return { threads, createThread, prepare, addSelection, removeSelection, removeThread, importSession, ask, cancel };
}

// ----------------------------------------------------------------------------
// Persisted panel width
// ----------------------------------------------------------------------------

export const PANEL_WIDTH_KEY = 'ah.ask.panelWidth';
export const PANEL_MIN_WIDTH = 380;
export const PANEL_DEFAULT_WIDTH = 560;
export function panelMaxWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, Math.floor(window.innerWidth * 0.75));
}
export function clampPanelWidth(w: number): number {
  return Math.min(panelMaxWidth(), Math.max(PANEL_MIN_WIDTH, Math.round(w)));
}

export function usePersistedPanelWidth(): [number, (w: number) => void] {
  const [width, setWidthState] = useState<number>(() => {
    try {
      const v = parseInt(window.localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
      return Number.isFinite(v) ? clampPanelWidth(v) : PANEL_DEFAULT_WIDTH;
    } catch {
      return PANEL_DEFAULT_WIDTH;
    }
  });
  const setWidth = useCallback((w: number) => {
    const c = clampPanelWidth(w);
    setWidthState(c);
    try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(c)); } catch { /* ignore */ }
  }, []);
  return [width, setWidth];
}
