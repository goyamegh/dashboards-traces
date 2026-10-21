/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E — "highlight & ask" prototype, one test per UI variant
 * (`?ask=popover|margin|panel`). Synthetic data: a real test case is created
 * through the storage API (and cleaned up by the tracker); the ANSWERING AGENT
 * is stubbed at the HTTP boundary (`POST /api/ask`) with a held SSE stream so
 * the loading → streaming → done states are all exercised. Sessions / agents
 * endpoints are stubbed with real-shaped lists (3+ items, identical names).
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { uniqueTestName } from '../helpers/testDataTracker';

const PROMPT_SENTENCE = 'The checkout service returns HTTP 503 for roughly four percent of requests since the last deploy.';

async function seedTestCase(request: APIRequestContext, name: string) {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/ask-highlight.spec.ts',
      labels: ['category:RCA', 'difficulty:Medium'],
      category: 'RCA',
      difficulty: 'Medium',
      isPromoted: false,
      initialPrompt: `${PROMPT_SENTENCE} Find the root cause.`,
      context: [],
      expectedOutcomes: ['Agent identifies the failing dependency', 'Agent proposes a rollback'],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  return (await res.json()) as { id: string };
}

/** Select `text` inside the first element containing it and fire mouseup so the ask listener captures it. */
async function selectText(page: Page, text: string) {
  const loc = page.getByText(text, { exact: false }).first();
  await loc.waitFor();
  await loc.scrollIntoViewIfNeeded();
  const ok = await loc.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = node.textContent?.indexOf(needle) ?? -1;
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
    }
    return false;
  }, text);
  expect(ok, 'text node found for selection').toBe(true);
  await page.mouse.move(300, 300);
  await page.mouse.up();
}

interface AskStub {
  bodies: any[];
  /** Resolve to let the held stream finish. */
  release: () => void;
}

/** Stub POST /api/ask: emits meta + a tool event immediately, then HOLDS until released, then streams the answer. */
async function stubAsk(page: Page, answer: string, agentName = 'Stub agent'): Promise<AskStub> {
  const bodies: any[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(/\/api\/ask$/, async (route: Route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    const sessionId = body.sessionId ?? `ask-e2e-${bodies.length}`;
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    await gate;
    const chunks = answer.split(' ');
    const sse =
      ev({ type: 'meta', sessionId, turnId: 't1', agent: { key: body.agentKey ?? 'builtin-pi', name: agentName, connectorType: 'pi-sdk' }, refs: { testCaseId: 'tc-stub' }, loaded: ['test case tc-stub'] }) +
      ev({ type: 'tool', name: 'get_test_case', status: 'start' }) +
      ev({ type: 'tool', name: 'get_test_case', status: 'end' }) +
      chunks.map((c, i) => ev({ type: 'delta', content: (i ? ' ' : '') + c })).join('') +
      ev({ type: 'done', answer, durationMs: 4200, firstTokenMs: 900, toolCalls: ['get_test_case'] });
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse });
  });
  return { bodies, release: () => release() };
}

/** Real-shaped sessions list; honours the server's `?route=` filter like the real endpoint does. */
async function stubSessions(page: Page, route: string) {
  await page.route(/\/api\/ask\/sessions(\?|$)/, (r) => {
    const url = new URL(r.request().url());
    const want = url.searchParams.get('route');
    const all = SESSIONS_FIXTURE(route).sessions;
    return r.fulfill({ json: { sessions: want ? all.filter((s) => s.page.route === want) : all } });
  });
}

const SESSIONS_FIXTURE = (route: string) => ({
  sessions: [
    { id: 'ask-1', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T09:00:00Z', agentKey: 'builtin-pi', agentName: 'Builtin', page: { route, title: 'Test case' }, firstQuestion: 'Why did this case fail?', firstSelection: 'Fact precision 12.5/100', turnCount: 2, lastAnswerPreview: 'Recall was 1/8.' },
    { id: 'ask-2', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T08:00:00Z', agentKey: 'claude', agentName: 'Claude Code CLI', page: { route: '/compare/b?runs=x,y', title: 'Compare Runs' }, firstQuestion: 'Why did this case fail?', turnCount: 1, lastAnswerPreview: 'Only the control run regressed.' },
    { id: 'ask-3', createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:00Z', agentKey: 'kiro', agentName: 'Kiro CLI', page: { route: '/compare/b?runs=x,y', title: 'Compare Runs' }, firstQuestion: 'What does this span do?', turnCount: 1, lastAnswerPreview: 'It marks a permission wait.' },
    { id: 'ask-4', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z', agentKey: 'builtin-pi', agentName: 'Builtin', page: { route: '/evaluations/runs/eval-run-9/inspect', title: 'Nightly' }, firstQuestion: 'Summarize this run', turnCount: 3, lastAnswerPreview: '' },
  ],
});

test.describe('highlight & ask prototype', () => {
  test('popover: select → Ask chip → composer → answer streams inline next to the selection', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-popover'));
    testData.testCase(tc.id);
    const stub = await stubAsk(page, 'The **503s** come from the payments dependency.\n\nLooked at: [test case](/evaluations/test-cases/tc-stub)');

    await page.goto(`/evaluations/test-cases/${tc.id}?ask=popover`);
    await page.waitForSelector('[data-testid="sidebar"]');
    await expect(page.locator('[data-testid="ask-surface"]')).toHaveAttribute('data-ask-variant', 'popover');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveCount(0);

    await selectText(page, 'HTTP 503 for roughly four percent');
    const chip = page.locator('[data-testid="ask-chip"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Ask/);
    await chip.click();

    const popover = page.locator('[data-testid="ask-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover.locator('[data-testid="ask-selection-quote"]')).toContainText('HTTP 503 for roughly four percent');
    await expect(popover.locator('[data-testid="ask-suggestion"]').first()).toBeVisible();

    await popover.locator('[data-testid="ask-composer-input"]').fill('Why did this case fail?');
    await page.keyboard.press('Enter');
    // Held request → waiting state is visible, not a blank card.
    await expect(popover.locator('[data-testid="ask-turn-waiting"]')).toBeVisible();
    await expect(popover.locator('[data-testid="ask-composer-cancel"]')).toBeVisible();

    stub.release();
    const answer = popover.locator('[data-testid="ask-turn-answer"]');
    await expect(answer).toContainText('come from the payments dependency');
    await expect(answer.locator('strong')).toHaveText('503s');
    await expect(popover.locator('[data-testid="ask-tool-activity"]')).toContainText('get_test_case');
    await expect(popover.locator('[data-testid="ask-turn-meta"]')).toContainText('first token 0.9s');
    await expect(popover.locator('[data-testid="ask-loaded"]')).toContainText('test case tc-stub');

    // What the server received: question + the highlighted text + the PATH route (no ?ask flag).
    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0].question).toBe('Why did this case fail?');
    expect(stub.bodies[0].selections[0].text).toContain('HTTP 503 for roughly four percent');
    expect(stub.bodies[0].pageContext.route).toBe(`/evaluations/test-cases/${tc.id}`);
    expect(stub.bodies[0].variant).toBe('popover');

    // Follow-up continues the same session.
    await popover.locator('[data-testid="ask-composer-input"]').fill('And the fix?');
    await page.keyboard.press('Enter');
    await expect(popover.locator('[data-testid="ask-turn"]')).toHaveCount(2);
    expect(stub.bodies[1].sessionId).toBe('ask-e2e-1');
    expect(stub.bodies[1].selections).toEqual([]);

    // Internal PATH links navigate in-app.
    await popover.locator('a', { hasText: 'test case' }).first().click();
    await expect(page).toHaveURL(/\/evaluations\/test-cases\/tc-stub/);
  });

  test('margin: select → note pinned in the right margin with the answer; earlier notes for this page listed', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-margin'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await stubSessions(page, route);
    const stub = await stubAsk(page, 'Because the dependency timed out.');

    await page.goto(`${route}?ask=margin`);
    await page.waitForSelector('[data-testid="sidebar"]');
    const margin = page.locator('[data-testid="ask-margin"]');
    await expect(margin).toBeVisible();
    // Content is pushed left, not covered.
    const pad = await page.locator('[data-testid="ask-surface"]').evaluate((el) => getComputedStyle(el).paddingRight);
    expect(parseInt(pad, 10)).toBeGreaterThan(300);
    // Persisted notes for THIS route only (1 of the 4 fixture sessions).
    await expect(margin.locator('[data-testid="ask-margin-history-item"]')).toHaveCount(1);
    await expect(margin.locator('[data-testid="ask-margin-history-item"]')).toContainText('Fact precision 12.5/100');

    await selectText(page, 'since the last deploy');
    await page.locator('[data-testid="ask-chip"]').click();
    const note = margin.locator('[data-testid="ask-note"]');
    await expect(note).toHaveCount(1);
    await expect(note).toHaveAttribute('data-draft', 'true');
    await expect(note.locator('[data-testid="ask-selection-quote"]')).toContainText('since the last deploy');

    await note.locator('[data-testid="ask-note-composer-input"]').fill('What does this mean?');
    await page.keyboard.press('Enter');
    await expect(note.locator('[data-testid="ask-turn-waiting"]')).toBeVisible();
    stub.release();
    await expect(note.locator('[data-testid="ask-turn-answer"]')).toContainText('Because the dependency timed out.');
    await expect(note.locator('[data-testid="ask-turn-meta"]')).toContainText('total 4.2s');
    expect(stub.bodies[0].variant).toBe('margin');

    // A second highlight pins a second note above; the first stays.
    await selectText(page, 'Find the root cause');
    await page.locator('[data-testid="ask-chip"]').click();
    await expect(margin.locator('[data-testid="ask-note"]')).toHaveCount(2);
    await expect(margin.locator('[data-testid="ask-note"]').first()).toHaveAttribute('data-draft', 'true');
  });

  test('panel: several highlights become context chips, the agent is picked from config, sessions list links back to pages', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-panel'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await page.route(/\/api\/ask\/agents$/, (r) => r.fulfill({ json: {
      configuredDefault: 'claude',
      agents: [
        { key: 'builtin-pi', name: 'Agent Health assistant', connectorType: 'pi-sdk', isDefault: false, kind: 'builtin' },
        { key: 'claude', name: 'Claude Code CLI', connectorType: 'claude-code', isDefault: true, kind: 'connector' },
        { key: 'kiro', name: 'Kiro CLI', connectorType: 'kiro', isDefault: false, kind: 'connector' },
        { key: 'pi', name: 'pi CLI', connectorType: 'pi', isDefault: false, kind: 'connector' },
      ],
    } }));
    await stubSessions(page, route);
    await page.route('**/api/ask/sessions/ask-3', (r) => r.fulfill({ json: { session: {
      id: 'ask-3', createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:00Z', agentKey: 'kiro', agentName: 'Kiro CLI',
      page: { route: '/compare/b?runs=x,y', title: 'Compare Runs' }, selections: [{ text: 'claude_code.tool.blocked_on_user' }],
      turns: [{ id: 'turn-1', question: 'What does this span do?', answer: 'It marks a permission wait.', selections: [], startedAt: '2026-10-19T10:00:00Z', toolCalls: ['query_spans'], firstTokenMs: 1200, durationMs: 3000 }],
    } } }));
    const stub = await stubAsk(page, 'Both highlights describe the same 503 symptom.', 'Claude Code CLI');

    await page.goto(`${route}?ask=panel`);
    await page.waitForSelector('[data-testid="sidebar"]');
    // Closed by default: a small opener, no reserved space.
    await expect(page.locator('[data-testid="ask-panel-open"]')).toBeVisible();
    await expect(page.locator('[data-testid="ask-panel"]')).toHaveCount(0);

    // Two highlights → two context chips in one thread.
    await selectText(page, 'HTTP 503');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveText(/Add to Ask/);
    await page.locator('[data-testid="ask-chip"]').click();
    const panel = page.locator('[data-testid="ask-panel"]');
    await expect(panel).toBeVisible();
    await selectText(page, 'since the last deploy');
    await page.locator('[data-testid="ask-chip"]').click();
    await expect(panel.locator('[data-testid="ask-context-chips"] [data-testid="ask-selection-quote"]')).toHaveCount(2);

    // Agent picker preselects the configured default and lists every chat-capable agent.
    const picker = panel.locator('[data-testid="ask-agent-picker"]');
    await expect(picker).toHaveValue('claude');
    await expect(picker.locator('option')).toHaveCount(4);
    await picker.selectOption('kiro');

    // Sessions list: 4 sessions grouped under 3 pages, identical questions kept apart.
    const list = panel.locator('[data-testid="ask-sessions-list"]');
    await expect(list.locator('[data-testid="ask-session-item"]')).toHaveCount(4);
    await expect(list.locator('[data-testid="ask-session-item"]', { hasText: 'Why did this case fail?' })).toHaveCount(2);

    await panel.locator('[data-testid="ask-panel-composer-input"]').fill('Are these the same problem?');
    await page.keyboard.press('Enter');
    await expect(panel.locator('[data-testid="ask-turn-waiting"]')).toBeVisible();
    // The picked agent is locked for the thread once a question is in flight.
    await expect(picker).toBeDisabled();
    stub.release();
    await expect(panel.locator('[data-testid="ask-turn-answer"]')).toContainText('same 503 symptom');
    expect(stub.bodies[0].agentKey).toBe('kiro');
    expect(stub.bodies[0].selections).toHaveLength(2);
    expect(stub.bodies[0].variant).toBe('panel');

    // Opening an earlier session shows its thread and offers a link back to its page.
    await list.locator('[data-testid="ask-session-item"]', { hasText: 'What does this span do?' }).click();
    await expect(panel.locator('[data-testid="ask-turn-answer"]')).toContainText('It marks a permission wait.');
    await expect(panel.locator('[data-testid="ask-context-chips"]')).toContainText('Asked on /compare/b?runs=x,y');
    await panel.getByText('Asked on /compare/b?runs=x,y').click();
    await expect(page).toHaveURL(/\/compare\/b\?runs=x,y/);
    // The panel survives navigation (variant is sticky) and keeps the thread.
    await expect(page.locator('[data-testid="ask-panel"]')).toBeVisible();
  });

  test('?ask=off disables the chip', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-off'));
    testData.testCase(tc.id);
    await page.goto(`/evaluations/test-cases/${tc.id}?ask=off`);
    await page.waitForSelector('[data-testid="sidebar"]');
    await selectText(page, 'HTTP 503');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveCount(0);
  });
});
