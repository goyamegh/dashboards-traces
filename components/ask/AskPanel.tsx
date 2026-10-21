/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Variant 3 — docked panel: highlights collect as context chips (several at
 * once), answers are threaded, the agent is picked from config, and the
 * sessions list on the left is the cross-page history (each links back to its
 * page). This is also where "Open in Assistant" from the popover lands.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus, ExternalLink, History } from 'lucide-react';
import { listAskAgents, listAskSessions, type AskAgentInfo, type AskSessionSummary } from '@/services/client/askApi';
import type { AskThread } from './askState';
import { AskComposer, SelectionQuote, TurnView, suggestionsFor } from './AskShared';

export const PANEL_WIDTH = 560;

export interface AskPanelProps {
  route: string;
  thread: AskThread | null;
  onAsk: (question: string, agentKey?: string) => void;
  onCancel: () => void;
  onRemoveSelection: (text: string) => void;
  onNewThread: () => void;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}

export const AskPanel: React.FC<AskPanelProps> = ({ route, thread, onAsk, onCancel, onRemoveSelection, onNewThread, onOpenSession, onClose }) => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AskAgentInfo[]>([]);
  const [agentKey, setAgentKey] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<AskSessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(true);
  const doneCount = thread?.turns.filter((t) => t.status !== 'streaming').length ?? 0;

  useEffect(() => {
    listAskAgents().then((r) => {
      setAgents(r.agents);
      setAgentKey((k) => k ?? r.agents.find((a) => a.isDefault)?.key ?? r.agents[0]?.key);
    }).catch(() => { /* picker stays empty; server default applies */ });
  }, []);
  useEffect(() => {
    let cancelled = false;
    listAskSessions({ limit: 100 }).then((s) => { if (!cancelled) setSessions(s); }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [doneCount, thread?.sessionId]);

  const busy = thread?.turns.some((t) => t.status === 'streaming') ?? false;
  // Once a thread has a turn its agent is fixed (the server keeps one session
  // per agent); the picker locks even before the server's meta names it.
  const locked = !!thread?.turns.length;
  const lockedAgent = locked ? (thread?.agent ?? (agentKey ? { key: agentKey, name: agents.find((a) => a.key === agentKey)?.name ?? agentKey, connectorType: '' } : undefined)) : undefined;
  const grouped = useMemo(() => {
    const byRoute = new Map<string, AskSessionSummary[]>();
    for (const s of sessions) {
      const list = byRoute.get(s.page.route) ?? [];
      list.push(s);
      byRoute.set(s.page.route, list);
    }
    return Array.from(byRoute.entries());
  }, [sessions]);

  return (
    <aside
      data-ask-ui
      data-testid="ask-panel"
      style={{ width: PANEL_WIDTH }}
      className="fixed right-0 top-0 bottom-0 z-40 border-l bg-background flex flex-col"
      aria-label="Assistant panel"
    >
      <div className="flex items-center justify-between border-b px-3 py-2 gap-2">
        <span className="text-xs font-semibold flex items-center gap-1 shrink-0"><span aria-hidden="true">✨</span> Assistant</span>
        <select
          className="h-7 flex-1 min-w-0 rounded-md border bg-background px-1 text-[11px]"
          value={lockedAgent?.key ?? agentKey ?? ''}
          disabled={locked}
          onChange={(e) => setAgentKey(e.target.value)}
          aria-label="Answering agent"
          data-testid="ask-agent-picker"
          title={locked ? 'The agent is fixed for a thread; start a new thread to switch.' : 'Which agent answers (from agent-health.config.ts)'}
        >
          {lockedAgent && !agents.some((a) => a.key === lockedAgent.key) ? <option value={lockedAgent.key}>{lockedAgent.name}</option> : null}
          {agents.map((a) => <option key={a.key} value={a.key}>{a.name} [{a.connectorType}]{a.isDefault ? ' · default' : ''}</option>)}
        </select>
        <button type="button" onClick={onNewThread} className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] hover:bg-accent shrink-0" data-testid="ask-panel-new"><Plus size={12} /> New</button>
        <button type="button" onClick={() => setShowHistory((v) => !v)} className={`rounded p-1 hover:bg-accent ${showHistory ? 'bg-accent' : ''}`} aria-label="Toggle history" data-testid="ask-panel-history-toggle"><History size={14} /></button>
        <button type="button" onClick={onClose} aria-label="Close panel" className="rounded p-1 hover:bg-accent" data-testid="ask-panel-close"><X size={14} /></button>
      </div>
      <div className="flex flex-1 min-h-0">
        {showHistory ? (
          <nav className="w-[190px] shrink-0 border-r overflow-y-auto p-2 space-y-2" data-testid="ask-sessions-list" aria-label="Ask sessions">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sessions</div>
            {sessions.length === 0 ? <p className="text-[11px] text-muted-foreground">No asks yet.</p> : null}
            {grouped.map(([r, list]) => (
              <div key={r} className="space-y-1">
                <button type="button" onClick={() => navigate(r)} className="w-full text-left text-[10px] text-muted-foreground hover:text-foreground truncate flex items-center gap-1" title={r}>
                  <ExternalLink size={9} className="shrink-0" /> <span className="truncate">{list[0].page.title || r}</span>
                </button>
                {list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpenSession(s.id)}
                    className={`w-full text-left rounded border px-1.5 py-1 hover:bg-accent ${thread?.sessionId === s.id ? 'border-primary bg-accent/50' : ''}`}
                    data-testid="ask-session-item"
                  >
                    <div className="text-[11px] font-medium line-clamp-2">{s.firstQuestion || '(no question)'}</div>
                    <div className="text-[10px] text-muted-foreground">{s.turnCount} turn{s.turnCount === 1 ? '' : 's'} · {relTime(s.updatedAt)}</div>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            <div className="space-y-1" data-testid="ask-context-chips">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Context ({thread?.selections.length ?? 0})</div>
              {thread?.selections.length ? thread.selections.map((s) => (
                <SelectionQuote key={s.text} selection={s} compact onRemove={thread.turns.length ? undefined : () => onRemoveSelection(s.text)} />
              )) : <p className="text-[11px] text-muted-foreground">Highlight text anywhere on the page and click <b>Add to Ask</b>; several highlights can be combined into one question.</p>}
              {thread?.route && thread.route !== route ? (
                <button type="button" onClick={() => navigate(thread.route)} className="text-[10px] text-opensearch-blue hover:underline inline-flex items-center gap-1"><ExternalLink size={9} /> Asked on {thread.route}</button>
              ) : null}
              {thread?.loaded?.length ? <div className="text-[10px] text-muted-foreground" data-testid="ask-loaded">Pre-loaded: {thread.loaded.join(' · ')}</div> : null}
            </div>
            {thread?.turns.map((turn) => <TurnView key={turn.id} turn={turn} thread={thread} />)}
          </div>
          <div className="border-t px-3 py-2">
            <AskComposer
              busy={busy}
              onSubmit={(q) => onAsk(q, lockedAgent?.key ?? agentKey)}
              onCancel={onCancel}
              placeholder={thread?.turns.length ? 'Follow up…' : thread?.selections.length ? 'Ask about the highlighted text…' : 'Ask about this page…'}
              suggestions={thread?.turns.length ? undefined : suggestionsFor(route, !!thread?.selections.length)}
              testId="ask-panel-composer"
            />
          </div>
        </div>
      </div>
    </aside>
  );
};

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
