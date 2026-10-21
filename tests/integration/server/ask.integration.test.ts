/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration — `POST /api/ask` (highlight & ask prototype) against a RUNNING
 * server at AH_PORT (file storage expected; see tests/integration/README).
 *
 *   - validation + agent resolution errors are plain 4xx JSON (no stream)
 *   - the real answering path: a report created through the storage API is
 *     the page context; the answer MUST quote data only the report holds.
 *     Agent: the server's configured default (`assistant.agentKey`) — in the
 *     prototype test server that is the REAL `pi` CLI (subprocess connector);
 *     elsewhere the built-in pi SDK. Skipped when neither credentials nor the
 *     `pi` binary are available (reported, never silently green).
 *   - sessions are persisted: GET /api/ask/sessions(/:id) show the turn.
 */

import { execSync } from 'child_process';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface SseCollected {
  meta?: any;
  deltas: string[];
  tools: any[];
  done?: any;
  error?: string;
}

async function postAsk(body: unknown, timeoutMs = 240_000): Promise<{ status: number; json?: any; sse?: SseCollected }> {
  const res = await fetch(`${BASE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: res.status, json: await res.json().catch(() => undefined) };
  }
  const collected: SseCollected = { deltas: [], tools: [] };
  const text = await res.text();
  for (const chunk of text.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'meta') collected.meta = ev;
    else if (ev.type === 'delta') collected.deltas.push(ev.content);
    else if (ev.type === 'tool') collected.tools.push(ev);
    else if (ev.type === 'done') collected.done = ev;
    else if (ev.type === 'error') collected.error = ev.error;
  }
  return { status: res.status, sse: collected };
}

describe('POST /api/ask (highlight & ask)', () => {
  let serverRunning = false;
  beforeAll(async () => {
    serverRunning = await isServerRunning();
    if (!serverRunning) console.warn('Server not running at', BASE_URL, '- skipping ask integration tests');
  });
  afterAll(async () => { await tracker.cleanup(); });

  it('400s on a malformed body without opening a stream', async () => {
    if (!serverRunning) return;
    const r1 = await postAsk({ pageContext: { route: '/x' } });
    expect(r1.status).toBe(400);
    expect(r1.json.error).toMatch(/question is required/);
    const r2 = await postAsk({ question: 'q', pageContext: {} });
    expect(r2.status).toBe(400);
    expect(r2.json.error).toMatch(/pageContext.route/);
    const r3 = await postAsk({ question: 'q', pageContext: { route: '/x' }, selections: [{ nope: 1 }] });
    expect(r3.status).toBe(400);
  });

  it('400s with a clear message for an unknown or non-chat agentKey', async () => {
    if (!serverRunning) return;
    const r = await postAsk({ question: 'q', pageContext: { route: '/' }, agentKey: 'definitely-not-configured' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('not-found');
    expect(r.json.error).toMatch(/"definitely-not-configured" is not in agents\[\]/);

    // Any configured agent that is NOT chat-capable must be rejected by name.
    const agents = await fetch(`${BASE_URL}/api/agents`).then((x) => x.json()).catch(() => null);
    const list: any[] = agents?.agents ?? agents ?? [];
    const rest = list.find((a) => a.connectorType && !['claude-code', 'kiro', 'pi'].includes(a.connectorType));
    if (rest) {
      const r2 = await postAsk({ question: 'q', pageContext: { route: '/' }, agentKey: rest.key });
      expect(r2.status).toBe(400);
      expect(r2.json.code).toBe('unsupported-connector');
      expect(r2.json.error).toContain(`connector "${rest.connectorType}"`);
    }
  });

  it('GET /api/ask/agents lists the builtin first and flags the configured default', async () => {
    if (!serverRunning) return;
    const data = await fetch(`${BASE_URL}/api/ask/agents`).then((r) => r.json());
    expect(data.agents[0]).toMatchObject({ key: 'builtin-pi', kind: 'builtin' });
    expect(data.agents.filter((a: any) => a.isDefault)).toHaveLength(1);
    for (const a of data.agents.slice(1)) expect(['claude-code', 'kiro', 'pi']).toContain(a.connectorType);
  });

  it('answers a question about a REAL report grounded in its stored judge reasoning, and persists the session', async () => {
    if (!serverRunning) return;
    const agentsInfo = await fetch(`${BASE_URL}/api/ask/agents`).then((r) => r.json());
    const def = agentsInfo.agents.find((a: any) => a.isDefault);
    const piOnPath = (() => { try { execSync('pi --version', { stdio: 'pipe', timeout: 5000 }); return true; } catch { return false; } })();
    if (def?.connectorType === 'pi' && !piOnPath) {
      console.warn('SKIP: default ask agent is the pi CLI but `pi` is not on PATH');
      return;
    }

    // A report whose judge reasoning carries a sentinel only this doc contains.
    const sentinel = `sentinel-${Date.now().toString(36)}`;
    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('ask-int'), description: 'ask integration', labels: ['category:RCA', 'difficulty:Easy'],
        category: 'RCA', difficulty: 'Easy', initialPrompt: 'Why is checkout slow?', context: [],
        expectedOutcomes: ['Names the slow dependency'],
      }),
    });
    expect(tcRes.ok).toBe(true);
    const tc = await tcRes.json();
    tracker.testCase(tc.id);
    const repRes = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId: tc.id, testCaseVersion: 1, agentKey: 'demo', agentName: 'Demo agent', modelId: 'demo', status: 'completed',
        passFailStatus: 'failed', metrics: { accuracy: 20 },
        llmJudgeReasoning: `The agent blamed the database, but the slow dependency was the ${sentinel} payment gateway (p99 4.2s). Outcome not achieved.`,
        trajectory: [
          { id: 's1', timestamp: 1, type: 'assistant', content: 'Checking the database first.' },
          { id: 's2', timestamp: 2, type: 'action', toolName: 'query_metrics', content: '{"service":"db"}' },
          { id: 's3', timestamp: 3, type: 'tool_result', toolName: 'query_metrics', content: 'db p99 = 40ms' },
          { id: 's4', timestamp: 4, type: 'response', content: 'The database is slow.' },
        ],
        timestamp: new Date().toISOString(),
      }),
    });
    expect(repRes.ok).toBe(true);
    const report = (await repRes.json());
    const reportId: string = report.id ?? report.run?.id;
    tracker.run(reportId);

    const route = `/runs/${reportId}`;
    const r = await postAsk({
      question: 'In one or two sentences: which dependency does the judge say was actually slow, and did the agent pass?',
      selections: [{ text: 'Outcome not achieved.' }],
      pageContext: { route, title: 'Run details' },
      variant: 'integration-test',
    });
    expect(r.status).toBe(200);
    const sse = r.sse!;
    if (sse.error && /no credentialed model|Not logged in|credentials|ExpiredToken/i.test(sse.error)) {
      console.warn('SKIP (no LLM credentials for the ask agent):', sse.error);
      return;
    }
    expect(sse.error).toBeUndefined();
    expect(sse.meta.agent.key).toBe(def.key);
    expect(sse.meta.refs).toMatchObject({ reportId, testCaseId: tc.id });
    expect(sse.meta.loaded).toEqual(expect.arrayContaining([`report ${reportId}`, `test case ${tc.id}`]));
    expect(sse.done).toBeDefined();
    const answer: string = sse.done.answer;
    // Grounded: the sentinel exists ONLY in the stored report's judge reasoning.
    expect(answer).toContain(sentinel);
    expect(answer).toMatch(/fail|did not pass|not pass/i);
    expect(sse.deltas.join('').length).toBeGreaterThan(0);
    expect(typeof sse.done.durationMs).toBe('number');

    // Persisted session with the turn, answer and timings; listed newest-first and filterable by route.
    const session = await fetch(`${BASE_URL}/api/ask/sessions/${sse.meta.sessionId}`).then((x) => x.json());
    expect(session.session.turns).toHaveLength(1);
    expect(session.session.turns[0]).toMatchObject({ answer, question: expect.stringContaining('which dependency') });
    expect(session.session.selections[0].text).toBe('Outcome not achieved.');
    expect(session.session.page.route).toBe(route);
    const list = await fetch(`${BASE_URL}/api/ask/sessions?route=${encodeURIComponent(route)}`).then((x) => x.json());
    expect(list.sessions.map((s: any) => s.id)).toContain(sse.meta.sessionId);
    expect(list.sessions[0]).toMatchObject({ firstSelection: 'Outcome not achieved.', turnCount: 1 });
    expect(await fetch(`${BASE_URL}/api/ask/sessions/does-not-exist`).then((x) => x.status)).toBe(404);
  }, 300_000);
});
