/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask sessions: every "highlight & ask" thread (question, selections, page,
 * agent, answer, timings). PROTOTYPE persistence: one local JSON file under
 * `.agent-health/` (gitignored, never the shared OpenSearch cluster). The
 * production version would be a storage-module collection.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import type { AskPageContext, AskSelection } from './askContext';

export interface AskTurn {
  id: string;
  question: string;
  answer: string;
  /** Selections attached to THIS turn (follow-ups may add more). */
  selections: AskSelection[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Time from request start to the first streamed token. */
  firstTokenMs?: number;
  /** Names of tools the agent invoked while answering. */
  toolCalls: string[];
  error?: string;
}

export interface AskSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentKey: string;
  agentName: string;
  page: AskPageContext;
  /** Union of all selections across turns (first turn first). */
  selections: AskSelection[];
  turns: AskTurn[];
  /** UI variant that created it (popover | margin | panel). */
  variant?: string;
}

export interface AskSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentKey: string;
  agentName: string;
  page: AskPageContext;
  variant?: string;
  firstQuestion: string;
  firstSelection?: string;
  turnCount: number;
  lastAnswerPreview: string;
}

interface FileShape {
  version: 1;
  sessions: AskSession[];
}

export const ASK_SESSIONS_MAX = 500;

export class AskSessionStore {
  private cache: FileShape | null = null;

  constructor(private readonly filePath: string) {}

  static defaultPath(cwd = process.cwd()): string {
    return process.env.AH_ASK_SESSIONS_FILE || resolve(cwd, '.agent-health', 'ask-sessions.json');
  }

  private load(): FileShape {
    if (this.cache) return this.cache;
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (parsed && Array.isArray(parsed.sessions)) {
          this.cache = { version: 1, sessions: parsed.sessions };
          return this.cache;
        }
      } catch {
        // Corrupt file: start fresh but keep the old file aside.
        try { renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    this.cache = { version: 1, sessions: [] };
    return this.cache;
  }

  private save(): void {
    const data = this.load();
    if (data.sessions.length > ASK_SESSIONS_MAX) {
      data.sessions = data.sessions
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, ASK_SESSIONS_MAX);
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1));
    renameSync(tmp, this.filePath);
  }

  list(opts: { route?: string; limit?: number } = {}): AskSessionSummary[] {
    const { sessions } = this.load();
    const filtered = opts.route ? sessions.filter((s) => s.page.route === opts.route) : sessions;
    return filtered
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, opts.limit ?? 200)
      .map(summarize);
  }

  get(id: string): AskSession | null {
    return this.load().sessions.find((s) => s.id === id) ?? null;
  }

  create(input: {
    id?: string;
    agentKey: string;
    agentName: string;
    page: AskPageContext;
    selections: AskSelection[];
    variant?: string;
  }): AskSession {
    const now = new Date().toISOString();
    const session: AskSession = {
      id: input.id ?? `ask-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      agentKey: input.agentKey,
      agentName: input.agentName,
      page: input.page,
      selections: input.selections,
      turns: [],
      variant: input.variant,
    };
    this.load().sessions.push(session);
    this.save();
    return session;
  }

  /** Get an existing session or create one with the given id. */
  getOrCreate(id: string | undefined, input: Parameters<AskSessionStore['create']>[0]): AskSession {
    if (id) {
      const found = this.get(id);
      if (found) return found;
    }
    return this.create({ ...input, id });
  }

  startTurn(sessionId: string, question: string, selections: AskSelection[]): AskTurn {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Ask session ${sessionId} not found`);
    const turn: AskTurn = {
      id: `turn-${randomUUID()}`,
      question,
      answer: '',
      selections,
      startedAt: new Date().toISOString(),
      toolCalls: [],
    };
    session.turns.push(turn);
    for (const s of selections) {
      if (!session.selections.some((x) => x.text === s.text)) session.selections.push(s);
    }
    session.updatedAt = turn.startedAt;
    this.save();
    return turn;
  }

  finishTurn(
    sessionId: string,
    turnId: string,
    patch: Partial<Pick<AskTurn, 'answer' | 'durationMs' | 'firstTokenMs' | 'toolCalls' | 'error'>>
  ): AskTurn | null {
    const session = this.get(sessionId);
    const turn = session?.turns.find((t) => t.id === turnId);
    if (!session || !turn) return null;
    Object.assign(turn, patch);
    turn.completedAt = new Date().toISOString();
    session.updatedAt = turn.completedAt;
    this.save();
    return turn;
  }

  /** Test hook. */
  clearAll(): void {
    this.cache = { version: 1, sessions: [] };
    this.save();
  }
}

function summarize(s: AskSession): AskSessionSummary {
  const first = s.turns[0];
  const last = s.turns[s.turns.length - 1];
  return {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    agentKey: s.agentKey,
    agentName: s.agentName,
    page: s.page,
    variant: s.variant,
    firstQuestion: first?.question ?? '',
    firstSelection: s.selections[0]?.text?.slice(0, 160),
    turnCount: s.turns.length,
    lastAnswerPreview: (last?.answer || last?.error || '').slice(0, 200),
  };
}

let defaultStore: AskSessionStore | null = null;
export function getAskSessionStore(): AskSessionStore {
  if (!defaultStore) defaultStore = new AskSessionStore(AskSessionStore.defaultPath());
  return defaultStore;
}
