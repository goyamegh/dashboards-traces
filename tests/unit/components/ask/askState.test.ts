/**
 * @jest-environment jsdom
 */
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';

const mockPrepare = jest.fn();
const mockStream = jest.fn();
const mockStatus = jest.fn();
jest.mock('@/services/client/askApi', () => ({
  prepareAsk: (...a: any[]) => mockPrepare(...a),
  streamAsk: (...a: any[]) => mockStream(...a),
  getAskStatus: (...a: any[]) => mockStatus(...a),
}));

import {
  buildPageContext, clampPanelWidth, usePersistedPanelWidth, PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH,
  openAskPanel, onOpenAskPanel, useAskThreads, useTextSelection, useAskStatus,
} from '@/components/ask/askState';

afterEach(() => { jest.useRealTimers(); });
beforeEach(() => {
  window.localStorage.clear();
  mockPrepare.mockReset(); mockStream.mockReset(); mockStatus.mockReset();
  document.body.innerHTML = '';
});

describe('buildPageContext', () => {
  it('prefers the breadcrumb trail, then a non-brand h1, then document.title', () => {
    document.title = 'Agent Health';
    expect(buildPageContext('/x').title).toBe('Agent Health');
    document.body.innerHTML = '<h1>OpenSearch AgentHealth</h1><h1>Compare Runs</h1>';
    expect(buildPageContext('/x')).toEqual({ route: '/x', title: 'Compare Runs' });
    document.body.innerHTML += '<nav aria-label="Breadcrumb"><a>Evaluations</a><span>›</span><a>my-benchmark</a><span>Nightly</span></nav>';
    expect(buildPageContext('/x').title).toBe('Evaluations › my-benchmark › Nightly');
  });
});

describe('panel width', () => {
  it('clamps between the minimum and 75% of the window', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000)).toBe(1200);
    expect(clampPanelWidth(640.4)).toBe(640);
  });

  it('usePersistedPanelWidth reads, clamps and persists to localStorage', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    const { result } = renderHook(() => usePersistedPanelWidth());
    expect(result.current[0]).toBe(PANEL_DEFAULT_WIDTH);
    act(() => result.current[1](760));
    expect(result.current[0]).toBe(760);
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('760');
    window.localStorage.setItem(PANEL_WIDTH_KEY, '50');
    expect(renderHook(() => usePersistedPanelWidth()).result.current[0]).toBe(PANEL_MIN_WIDTH);
    window.localStorage.setItem(PANEL_WIDTH_KEY, 'garbage');
    expect(renderHook(() => usePersistedPanelWidth()).result.current[0]).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe('open-panel event bus', () => {
  it('delivers the detail to subscribers until unsubscribed', () => {
    const seen: any[] = [];
    const off = onOpenAskPanel((d) => seen.push(d));
    openAskPanel({ question: 'why?' });
    openAskPanel();
    off();
    openAskPanel({ question: 'ignored' });
    expect(seen).toEqual([{ question: 'why?' }, {}]);
  });
});

describe('useAskStatus', () => {
  it('fetches once and exposes the status; a failing fetch leaves it null (treated as enabled)', async () => {
    mockStatus.mockResolvedValue({ enabled: false, local: true });
    const { result } = renderHook(() => useAskStatus());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toMatchObject({ enabled: false });
    mockStatus.mockRejectedValue(new Error('down'));
    const r2 = renderHook(() => useAskStatus());
    await act(async () => { await Promise.resolve(); });
    expect(r2.result.current).toBeNull();
  });
});

describe('useTextSelection', () => {
  function selectAll(el: Element) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // jsdom has no layout: give the range a non-empty rect
    (range as any).getBoundingClientRect = () => ({ top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 });
    jest.spyOn(sel, 'getRangeAt').mockReturnValue(range);
  }

  it('reports a selection outside the ask UI after mouseup, ignores selections inside [data-ask-ui], clears on mousedown', async () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<p id="p">The checkout service returns HTTP 503 since the last deploy.</p><div data-ask-ui><span id="inside">answer text</span></div>';
    const { result } = renderHook(() => useTextSelection());
    expect(result.current[0]).toBeNull();

    selectAll(document.getElementById('p')!);
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')); jest.runAllTimers(); });
    expect(result.current[0]).toMatchObject({ text: 'The checkout service returns HTTP 503 since the last deploy.', rect: { top: 10, width: 100 } });
    expect(result.current[0]!.nearbyText).toContain('checkout service');

    // a click outside the ask UI dismisses it
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(result.current[0]).toBeNull();

    // text selected inside the ask UI is never offered
    selectAll(document.getElementById('inside')!);
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')); jest.runAllTimers(); });
    expect(result.current[0]).toBeNull();
    jest.useRealTimers();
  });
});

describe('useAskThreads', () => {
  function streamOk(answer: string, sessionId = 'ask-s1') {
    mockStream.mockImplementation(async (_body: any, h: any) => {
      h.onMeta?.({ type: 'meta', sessionId: _body.sessionId ?? sessionId, turnId: 't', agent: { key: 'a', name: 'A', model: 'm' }, refs: { reportId: 'r' }, loaded: ['report r'], prepared: !!_body.sessionId });
      h.onTool?.({ type: 'tool', name: 'get_report', status: 'start' });
      h.onTool?.({ type: 'tool', name: 'get_report', status: 'end' });
      for (const d of answer.split(' ')) h.onDelta?.(d + ' ');
      return { type: 'done', answer, durationMs: 100, firstTokenMs: 10, toolCalls: ['get_report'] };
    });
  }

  it('createThread({prepare}) prepares in the background; ask() waits for it and sends the highlight once', async () => {
    let resolvePrepare: (v: any) => void = () => {};
    mockPrepare.mockImplementation(() => new Promise((r) => { resolvePrepare = r; }));
    streamOk('because recall');
    const { result } = renderHook(() => useAskThreads());
    let id = '';
    await act(async () => { id = result.current.createThread('/runs/r', [{ text: 'hl' }], { prepare: true }).id; await new Promise((r) => setTimeout(r, 5)); });
    expect(mockPrepare).toHaveBeenCalledWith({ pageContext: expect.objectContaining({ route: '/runs/r' }), selections: [{ text: 'hl' }] });
    expect(result.current.threads[id].preparing).toBe(true);

    let asking: Promise<void> = Promise.resolve();
    act(() => { asking = result.current.ask(id, 'why?'); });
    await act(async () => { await Promise.resolve(); });
    // ask() must not stream before the prepare settles
    expect(mockStream).not.toHaveBeenCalled();
    await act(async () => { resolvePrepare({ sessionId: 'ask-prep', refs: {}, loaded: ['report r'], model: 'm' }); await asking; });
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockStream.mock.calls[0][0]).toMatchObject({ question: 'why?', sessionId: 'ask-prep', selections: [{ text: 'hl' }] });
    const t = result.current.threads[id];
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ status: 'done', answer: 'because recall', firstTokenMs: 10, durationMs: 100 });
    expect(t.turns[0].tools.map((x) => x.status)).toEqual(['end']); // start collapsed into end
    expect(t.model).toBe('m');

    // follow-up: same session, no selections
    await act(async () => { await result.current.ask(id, 'and?'); });
    expect(mockStream.mock.calls[1][0]).toMatchObject({ sessionId: 'ask-prep', selections: [] });
    expect(result.current.threads[id].turns).toHaveLength(2);
  });

  it('a failed prepare falls back to an on-demand ask; stream errors land on the turn', async () => {
    mockPrepare.mockRejectedValue(new Error('500'));
    mockStream.mockRejectedValue(new Error('The assistant is already answering 4 questions; try again in a moment.'));
    const { result } = renderHook(() => useAskThreads());
    let id = '';
    await act(async () => { id = result.current.createThread('/x', [{ text: 'a' }], { prepare: true }).id; await new Promise((r) => setTimeout(r, 5)); });
    expect(result.current.threads[id].preparing).toBe(false);
    await act(async () => { await result.current.ask(id, 'q'); });
    expect(mockStream.mock.calls[0][0].sessionId).toBeUndefined();
    expect(result.current.threads[id].turns[0]).toMatchObject({ status: 'error', error: expect.stringContaining('already answering') });
  });

  it('addSelection dedupes, removeSelection removes, removeThread drops, importSession dedupes by pi session id', async () => {
    const { result } = renderHook(() => useAskThreads());
    let id = '';
    act(() => { id = result.current.createThread('/x', [{ text: 'a' }]).id; });
    act(() => { result.current.addSelection(id, { text: 'a' }); result.current.addSelection(id, { text: 'b' }); });
    expect(result.current.threads[id].selections.map((s) => s.text)).toEqual(['a', 'b']);
    act(() => { result.current.removeSelection(id, 'a'); });
    expect(result.current.threads[id].selections.map((s) => s.text)).toEqual(['b']);

    const session = { id: 'ask-9', page: { route: '/compare/b?runs=x,y' }, selections: [{ text: 's' }], model: 'm', turns: [{ id: 't1', question: 'q', answer: 'a', toolCalls: ['query_spans'], startedAt: '2026-10-19T10:00:00Z', firstTokenMs: 1, durationMs: 2 }] };
    let imported: any;
    act(() => { imported = result.current.importSession(session as any); });
    expect(imported.sessionId).toBe('ask-9');
    expect(imported.turns[0]).toMatchObject({ status: 'done', answer: 'a', tools: [{ name: 'query_spans', status: 'end' }] });
    let again: any;
    act(() => { again = result.current.importSession(session as any); });
    expect(again.id).toBe(imported.id);
    expect(Object.keys(result.current.threads)).toHaveLength(2);

    act(() => { result.current.removeThread(id); });
    expect(result.current.threads[id]).toBeUndefined();
  });

  it('cancel aborts the in-flight stream and marks the turn Cancelled', async () => {
    mockStream.mockImplementation((_b: any, _h: any, signal: AbortSignal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
    const { result } = renderHook(() => useAskThreads());
    let id = '';
    act(() => { id = result.current.createThread('/x', []).id; });
    let asking: Promise<void> = Promise.resolve();
    act(() => { asking = result.current.ask(id, 'q'); });
    await act(async () => { await Promise.resolve(); result.current.cancel(id); await asking; });
    expect(result.current.threads[id].turns[0]).toMatchObject({ status: 'error', error: 'Cancelled' });
  });
});
