/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask sessions are pi sessions — exercised against the REAL pi SDK
 * SessionManager and real files (no mock of the library's persistence):
 * the JSONL lands in our dedicated dir, carries our custom entries, and a
 * fresh store instance (= server restart) re-reads and re-opens it.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PiAskSessionStore, ASK_META_ENTRY, ASK_TURN_ENTRY, questionFromPrompt } from '@/server/services/ask/askSessionStore';

let SessionManager: any;
beforeAll(async () => {
  try {
    ({ SessionManager } = await import('@earendil-works/pi-coding-agent'));
  } catch {
    SessionManager = null;
  }
});

const page = { route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x', title: 'Inspector' };

describe('PiAskSessionStore (real pi SessionManager, real files)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ask-proto-pi-sessions-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const skip = () => { if (!SessionManager) { console.warn('pi SDK not installed — skipping'); return true; } return false; };

  function answered(store: PiAskSessionStore, question: string, answer: string, selections = [{ text: 'quoted' }]) {
    const sm = store.create({ page, selections, firstQuestion: question });
    // What pi itself appends during session.prompt(): the user message and the assistant message.
    sm.appendMessage({ role: 'user', content: [{ type: 'text', text: `## Highlighted text\n> quoted\n\n## Question\n${question}` }], timestamp: Date.now() });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: answer }], provider: 'amazon-bedrock', model: 'test-model', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });
    store.recordTurn(sm, { id: 't1', question, answer, selections, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });
    return sm;
  }

  it('writes a pi JSONL file into the dedicated dir (not ~/.pi), with our metadata as custom entries', () => {
    if (skip()) return;
    const store = new PiAskSessionStore(SessionManager, dir, '/some/project');
    const sm = answered(store, 'why?', 'because');
    const file = sm.getSessionFile();
    expect(file.startsWith(dir)).toBe(true);
    expect(file.endsWith(`_${sm.getSessionId()}.jsonl`)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'session', cwd: '/some/project' });
    expect(lines.find((l) => l.type === 'custom' && l.customType === ASK_META_ENTRY).data).toMatchObject({ page, selections: [{ text: 'quoted' }] });
    expect(lines.find((l) => l.type === 'session_info')).toMatchObject({ name: 'why?' });
    expect(lines.filter((l) => l.type === 'message').map((l) => l.message.role)).toEqual(['user', 'assistant']);
    expect(lines.find((l) => l.type === 'custom' && l.customType === ASK_TURN_ENTRY).data).toMatchObject({ question: 'why?', answer: 'because', toolCalls: ['get_report'] });
    expect(existsSync(join(process.env.HOME ?? '', '.pi', 'agent', 'sessions', 'some-project'))).toBe(false);
  });

  it('a fresh store (server restart) lists, filters by route, reads turns, and re-opens the pi session', () => {
    if (skip()) return;
    const a = new PiAskSessionStore(SessionManager, dir);
    const s1 = answered(a, 'first question', 'first answer');
    const s2 = answered(a, 'second question', 'second answer');
    const other = a.create({ page: { route: '/compare/b?runs=x,y' }, selections: [], firstQuestion: 'compare q' });
    other.appendMessage({ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: Date.now() });
    other.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a' }], provider: 'p', model: 'm', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });

    const b = new PiAskSessionStore(SessionManager, dir);
    const all = b.list();
    expect(all.map((s) => s.id).sort()).toEqual([s1.getSessionId(), s2.getSessionId(), other.getSessionId()].sort());
    expect(b.list({ route: page.route }).map((s) => s.firstQuestion).sort()).toEqual(['first question', 'second question']);

    const detail = b.get(s2.getSessionId())!;
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).toMatchObject({ question: 'second question', answer: 'second answer', durationMs: 1200, firstTokenMs: 300 });
    expect(detail.model).toBe('amazon-bedrock/test-model');
    expect(detail.firstSelection).toBe('quoted');

    // Re-open through pi: same id, same file, history intact for createAgentSession to resume.
    const reopened = b.open(s2.getSessionId())!;
    expect(reopened.getSessionId()).toBe(s2.getSessionId());
    expect(reopened.getSessionFile()).toBe(s2.getSessionFile());
    expect(reopened.getEntries().filter((e: any) => e.type === 'message')).toHaveLength(2);

    // A turn without our custom entry (crash mid-answer) is recovered from the pi messages.
    const recovered = b.get(other.getSessionId())!;
    expect(recovered.turns).toHaveLength(1);
    expect(recovered.turns[0]).toMatchObject({ question: 'q', answer: 'a' });
    expect(b.get('ask-does-not-exist')).toBeNull();
    expect(b.open('../../etc/passwd')).toBeNull();
  });

  it('ignores foreign pi sessions in the dir and never throws on them', () => {
    if (skip()) return;
    const store = new PiAskSessionStore(SessionManager, dir);
    const foreign = SessionManager.create('/elsewhere', dir);
    foreign.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
    foreign.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'yo' }], provider: 'p', model: 'm', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });
    expect(readdirSync(dir)).toHaveLength(1);
    expect(store.list()).toEqual([]);
    expect(store.get(foreign.getSessionId())).toBeNull();
  });

  it('questionFromPrompt strips the context we prepend', () => {
    expect(questionFromPrompt('## Page\nx\n\n## Question\nWhy did it fail?')).toBe('Why did it fail?');
    expect(questionFromPrompt('plain')).toBe('plain');
  });
});
