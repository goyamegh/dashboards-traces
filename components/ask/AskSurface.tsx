/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AskSurface — mounts "highlight & ask" on every page. The variant is chosen
 * with `?ask=popover|margin|panel` (sticky); `?ask=off` disables it.
 *
 * Wraps the page content so the margin / panel variants can reserve space on
 * the right instead of covering the page.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getAskSession } from '@/services/client/askApi';
import { useAskThreads, useAskVariant, useTextSelection, type AskVariant } from './askState';
import { AskChip } from './AskShared';
import { AskPopover } from './AskPopover';
import { AskMargin, MARGIN_WIDTH } from './AskMargin';
import { AskPanel, PANEL_WIDTH } from './AskPanel';

export const AskSurface: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const route = location.pathname + location.search.replace(/[?&]ask=[^&]*/g, '').replace(/^&/, '?');
  const [variant, setVariant] = useAskVariant();
  const [pending, clearPending] = useTextSelection(variant !== 'off');
  const threadsApi = useAskThreads(variant);
  const { threads, createThread, addSelection, removeSelection, removeThread, importSession, ask, cancel } = threadsApi;

  // popover: the one open thread + its anchor
  const [popover, setPopover] = useState<{ threadId: string; anchor: NonNullable<typeof pending>['rect'] } | null>(null);
  // margin: the draft note awaiting a question
  const [draftThreadId, setDraftThreadId] = useState<string | null>(null);
  // panel: open state + current thread
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelThreadId, setPanelThreadId] = useState<string | null>(null);

  // Leaving the page closes the popover (its anchor is gone).
  useEffect(() => { setPopover(null); setDraftThreadId(null); }, [location.pathname]);

  const startFromSelection = useCallback(() => {
    if (!pending) return;
    const sel = { text: pending.text, nearbyText: pending.nearbyText };
    if (variant === 'popover') {
      const t = createThread(route, [sel]);
      setPopover({ threadId: t.id, anchor: pending.rect });
    } else if (variant === 'margin') {
      const t = createThread(route, [sel]);
      setDraftThreadId(t.id);
    } else if (variant === 'panel') {
      const current = panelThreadId ? threads[panelThreadId] : null;
      if (current && current.turns.length === 0) {
        addSelection(current.id, sel);
      } else {
        const t = createThread(route, [sel]);
        setPanelThreadId(t.id);
      }
      setPanelOpen(true);
    }
    clearPending();
    document.getSelection()?.removeAllRanges();
  }, [pending, variant, route, createThread, addSelection, panelThreadId, threads, clearPending]);

  const openInPanel = useCallback(() => {
    if (!popover) return;
    setPanelThreadId(popover.threadId);
    setPopover(null);
    setVariant('panel');
    setPanelOpen(true);
  }, [popover, setVariant]);

  const openSession = useCallback(async (sessionId: string, target: AskVariant) => {
    const existing = Object.values(threads).find((t) => t.sessionId === sessionId);
    const t = existing ?? (await getAskSession(sessionId).then((s) => (s ? importSession(s) : null)));
    if (!t) return;
    if (target === 'panel') { setPanelThreadId(t.id); setPanelOpen(true); }
  }, [threads, importSession]);

  const reserve = variant === 'margin' ? MARGIN_WIDTH : variant === 'panel' && panelOpen ? PANEL_WIDTH : 0;
  const chipLabel = variant === 'panel' ? 'Add to Ask' : 'Ask';
  const marginThreads = Object.values(threads).filter((t) => t.route === route).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <div style={reserve ? { paddingRight: reserve } : undefined} data-testid="ask-surface" data-ask-variant={variant}>
        {children}
      </div>

      {pending && variant !== 'off' && !(variant === 'popover' && popover) ? (
        <AskChip rect={pending.rect} label={chipLabel} onClick={startFromSelection} />
      ) : null}

      {variant === 'popover' && popover && threads[popover.threadId] ? (
        <AskPopover
          anchor={popover.anchor}
          thread={threads[popover.threadId]}
          onAsk={(q) => ask(popover.threadId, q)}
          onCancel={() => cancel(popover.threadId)}
          onClose={() => setPopover(null)}
          onOpenInPanel={openInPanel}
        />
      ) : null}

      {variant === 'margin' ? (
        <AskMargin
          route={route}
          threads={marginThreads}
          draftThreadId={draftThreadId}
          onAsk={(id, q) => { setDraftThreadId(null); ask(id, q); }}
          onCancel={cancel}
          onDismiss={removeThread}
          onOpenSession={(id) => openSession(id, 'margin').then(() => { /* imported thread appears in the list */ })}
        />
      ) : null}

      {variant === 'panel' ? (
        panelOpen ? (
          <AskPanel
            route={route}
            thread={panelThreadId ? threads[panelThreadId] ?? null : null}
            onAsk={(q, agentKey) => {
              let id = panelThreadId;
              if (!id || !threads[id]) { id = createThread(route, []).id; setPanelThreadId(id); }
              ask(id, q, { agentKey });
            }}
            onCancel={() => panelThreadId && cancel(panelThreadId)}
            onRemoveSelection={(text) => panelThreadId && removeSelection(panelThreadId, text)}
            onNewThread={() => setPanelThreadId(createThread(route, []).id)}
            onOpenSession={(id) => openSession(id, 'panel')}
            onClose={() => setPanelOpen(false)}
          />
        ) : (
          <button
            type="button"
            data-ask-ui
            data-testid="ask-panel-open"
            onClick={() => setPanelOpen(true)}
            className="fixed right-4 bottom-20 z-40 rounded-full border bg-background px-3 py-1.5 text-xs shadow-md hover:bg-accent"
          >
            ✨ Assistant
          </button>
        )
      ) : null}
    </>
  );
};
