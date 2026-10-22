/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask sessions ARE pi sessions.
 *
 * Every "highlight & ask" thread is a pi session persisted by pi's own
 * `SessionManager` in pi's JSONL session format — one file per thread under a
 * DEDICATED directory (`<cwd>/.agent-health/ask-sessions/`, override with
 * `AH_ASK_SESSIONS_DIR`), NOT the default `~/.pi/agent/sessions/<cwd>` dir, so
 * they don't flood the user's pi-web sidebar. A follow-up re-opens the same
 * file (`SessionManager.open`) and pi rebuilds the model context from it, so
 * threads survive a server restart.
 *
 * Agent Health metadata rides along as pi `custom` entries (they never enter
 * the LLM context):
 *   - `agent-health.ask`       once, right after creation: page route/title + first selections
 *   - `agent-health.ask.turn`  after every answered question: question, answer, selections, timings, tools
 * The user/assistant messages themselves are the ordinary pi message entries.
 */

import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AskPageContext, AskSelection } from './askContext';

export const ASK_META_ENTRY = 'agent-health.ask';
export const ASK_TURN_ENTRY = 'agent-health.ask.turn';

export interface AskSessionMeta {
  page: AskPageContext;
  selections: AskSelection[];
  createdAt: string;
}

export interface AskTurn {
  id: string;
  question: string;
  answer: string;
  selections: AskSelection[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenMs?: number;
  toolCalls: string[];
  error?: string;
}

export interface AskSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  page: AskPageContext;
  firstQuestion: string;
  firstSelection?: string;
  turnCount: number;
  lastAnswerPreview: string;
  model?: string;
}

export interface AskSessionDetail extends AskSessionSummary {
  selections: AskSelection[];
  turns: AskTurn[];
}

/** The subset of pi's SessionManager class this store drives (typed loosely: the SDK is an optional dep). */
export interface PiSessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): any[];
  getSessionName(): string | undefined;
  getHeader(): any;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
}
export interface PiSessionManagerStatic {
  create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManagerLike;
  open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManagerLike;
}

export class PiAskSessionStore {
  constructor(
    private readonly SessionManager: PiSessionManagerStatic,
    readonly dir: string,
    private readonly cwd: string = process.cwd()
  ) {}

  /** New pi session file (written by pi on the first assistant message) + our meta entry. */
  create(input: { id?: string; page: AskPageContext; selections: AskSelection[]; firstQuestion?: string }): PiSessionManagerLike {
    mkdirSync(this.dir, { recursive: true });
    const sm = this.SessionManager.create(this.cwd, this.dir, { id: input.id ?? `ask-${randomUUID()}` });
    const meta: AskSessionMeta = { page: input.page, selections: input.selections, createdAt: new Date().toISOString() };
    sm.appendCustomEntry(ASK_META_ENTRY, meta);
    // pi's display name for the session = the first question (what pi-web / `pi --resume` would show).
    if (input.firstQuestion?.trim()) sm.appendSessionInfo(input.firstQuestion.slice(0, 120));
    return sm;
  }

  /** Locate a session file by its pi session id (`<timestamp>_<id>.jsonl`). */
  findFile(id: string): string | undefined {
    if (!existsSync(this.dir)) return undefined;
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== id) return undefined;
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(`_${id}.jsonl`))
      .map((f) => join(this.dir, f))[0];
  }

  /** Re-open a persisted session (follow-up after a restart). */
  open(id: string): PiSessionManagerLike | null {
    const file = this.findFile(id);
    return file ? this.SessionManager.open(file, this.dir) : null;
  }

  recordTurn(sm: PiSessionManagerLike, turn: AskTurn): void {
    sm.appendCustomEntry(ASK_TURN_ENTRY, turn);
  }

  get(id: string): AskSessionDetail | null {
    const file = this.findFile(id);
    if (!file) return null;
    return readSession(this.SessionManager.open(file, this.dir));
  }

  list(opts: { route?: string; limit?: number } = {}): AskSessionSummary[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: AskSessionSummary[] = [];
    for (const f of files) {
      try {
        const detail = readSession(this.SessionManager.open(join(this.dir, f), this.dir));
        if (!detail) continue;
        if (opts.route && detail.page.route !== opts.route) continue;
        const { selections: _s, turns: _t, ...summary } = detail;
        out.push(summary);
      } catch {
        // A foreign / corrupt file in the dir is skipped, never fatal.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, opts.limit ?? 200);
  }
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('');
  return '';
}

/** Rebuild the Agent Health view of a pi session from its entries. Returns null for files that aren't ask sessions. */
export function readSession(sm: PiSessionManagerLike): AskSessionDetail | null {
  const entries = sm.getEntries();
  const metaEntry = entries.find((e) => e.type === 'custom' && e.customType === ASK_META_ENTRY);
  if (!metaEntry) return null;
  const meta = metaEntry.data as AskSessionMeta;
  const turns: AskTurn[] = entries.filter((e) => e.type === 'custom' && e.customType === ASK_TURN_ENTRY).map((e) => e.data as AskTurn);
  // Fallback for a turn whose custom entry never got written (crash mid-answer):
  // pair user/assistant messages that aren't covered by a recorded turn.
  const messages = entries.filter((e) => e.type === 'message');
  const assistantCount = messages.filter((e) => e.message?.role === 'assistant').length;
  if (assistantCount > turns.length) {
    let pendingQ: { text: string; ts: string } | null = null;
    const recovered: AskTurn[] = [];
    for (const e of messages) {
      if (e.message?.role === 'user') pendingQ = { text: questionFromPrompt(textOf(e.message)), ts: e.timestamp };
      else if (e.message?.role === 'assistant' && pendingQ) {
        recovered.push({ id: e.id, question: pendingQ.text, answer: textOf(e.message), selections: [], startedAt: pendingQ.ts, completedAt: e.timestamp, toolCalls: [] });
        pendingQ = null;
      }
    }
    if (recovered.length > turns.length) turns.splice(0, turns.length, ...recovered);
  }
  let model: string | undefined;
  for (const e of messages) if (e.message?.role === 'assistant' && e.message?.model) model = `${e.message.provider ? e.message.provider + '/' : ''}${e.message.model}`;
  const selections: AskSelection[] = [...(meta.selections ?? [])];
  for (const t of turns) for (const s of t.selections ?? []) if (!selections.some((x) => x.text === s.text)) selections.push(s);
  const last = turns[turns.length - 1];
  const updatedAt = last?.completedAt ?? last?.startedAt ?? meta.createdAt;
  return {
    id: sm.getSessionId(),
    createdAt: meta.createdAt,
    updatedAt,
    page: meta.page,
    firstQuestion: turns[0]?.question ?? sm.getSessionName() ?? '',
    firstSelection: selections[0]?.text?.slice(0, 160),
    turnCount: turns.length,
    lastAnswerPreview: (last?.answer || last?.error || '').slice(0, 200),
    model,
    selections,
    turns,
  };
}

/** The question is the last `## Question` section of the prompt we send (see askContext.buildAskUserPrompt). */
export function questionFromPrompt(prompt: string): string {
  const i = prompt.lastIndexOf('## Question\n');
  return (i >= 0 ? prompt.slice(i + '## Question\n'.length) : prompt).trim();
}
