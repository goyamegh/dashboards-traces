/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AskSessionStore } from '@/server/services/ask/askSessionStore';

describe('AskSessionStore (local JSON file)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ask-proto-store-'));
    file = join(dir, 'nested', 'ask-sessions.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const page = { route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x', title: 'Inspector' };

  it('creates the file on first write, persists turns, and re-reads them in a fresh instance', () => {
    const store = new AskSessionStore(file);
    const s = store.create({ agentKey: 'builtin-pi', agentName: 'builtin', page, selections: [{ text: 'quoted' }], variant: 'popover' });
    const turn = store.startTurn(s.id, 'why?', [{ text: 'quoted' }]);
    store.finishTurn(s.id, turn.id, { answer: 'because', durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });

    const again = new AskSessionStore(file);
    const loaded = again.get(s.id)!;
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0]).toMatchObject({ question: 'why?', answer: 'because', durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });
    expect(loaded.turns[0].completedAt).toBeDefined();
    expect(JSON.parse(readFileSync(file, 'utf-8')).sessions).toHaveLength(1);
  });

  it('lists newest first with summaries and filters by route', () => {
    const store = new AskSessionStore(file);
    const a = store.create({ agentKey: 'k', agentName: 'n', page, selections: [{ text: 'first selection text' }] });
    store.startTurn(a.id, 'q-a', []);
    const b = store.create({ agentKey: 'k', agentName: 'n', page: { route: '/compare/b?runs=x,y' }, selections: [] });
    const t = store.startTurn(b.id, 'q-b', []);
    store.finishTurn(b.id, t.id, { answer: 'answer b' });

    const all = store.list();
    expect(all.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(all[0]).toMatchObject({ firstQuestion: 'q-b', turnCount: 1, lastAnswerPreview: 'answer b' });
    expect(all[1].firstSelection).toBe('first selection text');
    expect(store.list({ route: page.route }).map((s) => s.id)).toEqual([a.id]);
  });

  it('getOrCreate continues an existing session and unions new selections', () => {
    const store = new AskSessionStore(file);
    const s = store.create({ agentKey: 'k', agentName: 'n', page, selections: [{ text: 'one' }] });
    const same = store.getOrCreate(s.id, { agentKey: 'k', agentName: 'n', page, selections: [] });
    expect(same.id).toBe(s.id);
    store.startTurn(s.id, 'follow-up', [{ text: 'two' }, { text: 'one' }]);
    expect(store.get(s.id)!.selections.map((x) => x.text)).toEqual(['one', 'two']);
    const fresh = store.getOrCreate('ask-does-not-exist', { agentKey: 'k', agentName: 'n', page, selections: [] });
    expect(fresh.id).toBe('ask-does-not-exist');
  });

  it('records errors on the turn and survives a corrupt file', () => {
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    const store = new AskSessionStore(join(dir, 'corrupt.json'));
    expect(store.list()).toEqual([]);
    const s = store.create({ agentKey: 'k', agentName: 'n', page, selections: [] });
    const t = store.startTurn(s.id, 'q', []);
    store.finishTurn(s.id, t.id, { error: 'agent exploded' });
    expect(store.list()[0].lastAnswerPreview).toBe('agent exploded');
    expect(() => store.startTurn('nope', 'q', [])).toThrow(/not found/);
  });
});
