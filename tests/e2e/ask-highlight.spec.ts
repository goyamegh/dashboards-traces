/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E — the Agent Health assistant ("highlight & ask"): popover entry point,
 * docked resizable panel with the sessions list, chip labels, sidebar /
 * nudge / route openers. Synthetic data: a real test case is created through
 * the storage API (cleaned up by the tracker); the ANSWERING AGENT is stubbed
 * at the HTTP boundary (`/api/ask/prepare`, `/api/ask`, `/api/ask/sessions`)
 * with a held SSE stream so loading → streaming → done are all exercised.
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

/** The collapsed sidebar expands on hover (width transition); hover first so the click lands on the expanded entry. */
async function openPanelViaSidebar(page: Page) {
  const nav = page.locator('[data-testid="nav-assistant"]');
  await nav.hover();
  await page.waitForTimeout(400);
  await nav.click();
  await expect(page.locator('[data-testid="ask-panel"]')).toBeVisible();
}

interface AskStub {
  asks: any[];
  prepares: any[];
  release: () => void;
}

/** Stub prepare + ask. The ask stream emits meta + a tool event, HOLDS until released, then streams the answer. */
async function stubAsk(page: Page, answer: string): Promise<AskStub> {
  const asks: any[] = [];
  const prepares: any[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(/\/api\/ask\/prepare$/, async (route: Route) => {
    const body = route.request().postDataJSON();
    prepares.push(body);
    await route.fulfill({ json: { sessionId: `ask-e2e-prep-${prepares.length}`, refs: { testCaseId: 'tc-stub' }, loaded: ['test case tc-stub'], model: 'amazon-bedrock/test-model' } });
  });
  await page.route(/\/api\/ask$/, async (route: Route) => {
    const body = route.request().postDataJSON();
    asks.push(body);
    const sessionId = body.sessionId ?? `ask-e2e-${asks.length}`;
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    await gate;
    const chunks = answer.split(' ');
    const sse =
      ev({ type: 'meta', sessionId, turnId: 't1', agent: { key: 'agent-health-assistant', name: 'Agent Health assistant', model: 'amazon-bedrock/test-model' }, refs: { testCaseId: 'tc-stub' }, loaded: body.sessionId ? [] : ['test case tc-stub'], prepared: !!body.sessionId }) +
      ev({ type: 'tool', name: 'get_test_case', status: 'start' }) +
      ev({ type: 'tool', name: 'get_test_case', status: 'end' }) +
      chunks.map((c, i) => ev({ type: 'delta', content: (i ? ' ' : '') + c })).join('') +
      ev({ type: 'done', answer, durationMs: 4200, firstTokenMs: 900, toolCalls: ['get_test_case'] });
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse });
  });
  return { asks, prepares, release: () => release() };
}

const SESSIONS_FIXTURE = (route: string) => ({
  dir: '/tmp/x/.agent-health/ask-sessions',
  sessions: [
    { id: 'ask-1', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T09:00:00Z', page: { route, title: 'Test case' }, firstQuestion: 'Why did this case fail?', firstSelection: 'Fact precision 12.5/100', turnCount: 2, lastAnswerPreview: 'Recall was 1/8.', model: 'amazon-bedrock/m' },
    { id: 'ask-2', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T08:00:00Z', page: { route: '/compare/b?runs=x,y', title: 'Compare Runs' }, firstQuestion: 'Why did this case fail?', turnCount: 1, lastAnswerPreview: 'Only the control run regressed.' },
    { id: 'ask-3', createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:00Z', page: { route: '/compare/b?runs=x,y', title: 'Compare Runs' }, firstQuestion: 'What does this span do?', turnCount: 1, lastAnswerPreview: 'It marks a permission wait.' },
    { id: 'ask-4', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z', page: { route: '/evaluations/runs/eval-run-9/inspect', title: 'Nightly' }, firstQuestion: 'Summarize this run', turnCount: 3, lastAnswerPreview: '' },
  ],
});

/** Real-shaped sessions list; honours the server's `?route=` filter like the real endpoint does. */
async function stubSessions(page: Page, route: string) {
  await page.route(/\/api\/ask\/sessions(\?|$)/, (r) => {
    const url = new URL(r.request().url());
    const want = url.searchParams.get('route');
    const all = SESSIONS_FIXTURE(route).sessions;
    return r.fulfill({ json: { dir: SESSIONS_FIXTURE(route).dir, sessions: want ? all.filter((s) => s.page.route === want) : all } });
  });
  await page.route(/\/api\/ask\/sessions\/ask-3$/, (r) => r.fulfill({ json: { session: {
    ...SESSIONS_FIXTURE(route).sessions[2], selections: [{ text: 'claude_code.tool.blocked_on_user' }],
    turns: [{ id: 'turn-1', question: 'What does this span do?', answer: 'It marks a permission wait.', selections: [], startedAt: '2026-10-19T10:00:00Z', toolCalls: ['query_spans'], firstTokenMs: 1200, durationMs: 3000 }],
  } } }));
}

test.describe('Agent Health assistant — highlight & ask', () => {
  // The sidebar's lower entries (Assistant, Settings) scroll out of view at the
  // default 720px viewport; use a laptop-sized window.
  test.use({ viewport: { width: 1280, height: 900 } });

  test('popover: Ask chip → prepare → composer → inline answer → follow-up → Open in panel', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-popover'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await stubSessions(page, route);
    const stub = await stubAsk(page, 'The **503s** come from the payments dependency.\n\nLooked at: [test case](/evaluations/test-cases/tc-stub)');

    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveCount(0);

    await selectText(page, 'HTTP 503 for roughly four percent');
    const chip = page.locator('[data-testid="ask-chip"]');
    await expect(chip).toHaveText(/^✨ Ask$/);
    // No panel thread → no "Add to current question".
    await expect(page.locator('[data-testid="ask-chip-add"]')).toHaveCount(0);
    await chip.click();

    const popover = page.locator('[data-testid="ask-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover.locator('[data-testid="ask-selection-quote"]')).toContainText('HTTP 503 for roughly four percent');
    // Clicking the chip prepared the snapshot + pi session before any question was typed.
    await expect.poll(() => stub.prepares.length).toBe(1);
    expect(stub.prepares[0].selections[0].text).toContain('HTTP 503');
    expect(stub.prepares[0].pageContext.route).toBe(route);
    await expect(popover.locator('[data-testid="ask-loaded"]')).toContainText('Context ready: test case tc-stub');

    await popover.locator('[data-testid="ask-composer-input"]').fill('Why did this case fail?');
    await page.keyboard.press('Enter');
    await expect(popover.locator('[data-testid="ask-turn-waiting"]')).toContainText('Thinking');
    await expect(popover.locator('[data-testid="ask-composer-cancel"]')).toBeVisible();

    stub.release();
    const answer = popover.locator('[data-testid="ask-turn-answer"]');
    await expect(answer).toContainText('come from the payments dependency');
    await expect(answer.locator('strong')).toHaveText('503s');
    await expect(popover.locator('[data-testid="ask-tool-activity"]')).toContainText('get_test_case');
    await expect(popover.locator('[data-testid="ask-turn-meta"]')).toContainText('first token 0.9s');

    expect(stub.asks).toHaveLength(1);
    expect(stub.asks[0]).toMatchObject({ question: 'Why did this case fail?', sessionId: 'ask-e2e-prep-1' });
    expect(stub.asks[0].selections[0].text).toContain('HTTP 503 for roughly four percent');
    expect(stub.asks[0].pageContext.route).toBe(route);

    // Follow-up continues the same pi session, without re-sending the highlight.
    await popover.locator('[data-testid="ask-composer-input"]').fill('And the fix?');
    await page.keyboard.press('Enter');
    await expect(popover.locator('[data-testid="ask-turn"]')).toHaveCount(2);
    expect(stub.asks[1].sessionId).toBe('ask-e2e-prep-1');
    expect(stub.asks[1].selections).toEqual([]);

    // Open in panel: the same thread (2 turns) continues in the docked panel; the popover closes.
    await popover.locator('[data-testid="ask-open-in-panel"]').click();
    await expect(popover).toHaveCount(0);
    const panel = page.locator('[data-testid="ask-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="ask-turn"]')).toHaveCount(2);
    await panel.locator('[data-testid="ask-panel-composer-input"]').fill('Third?');
    await page.keyboard.press('Enter');
    await expect(panel.locator('[data-testid="ask-turn"]')).toHaveCount(3);
    expect(stub.asks[2].sessionId).toBe('ask-e2e-prep-1');

    // Internal PATH links navigate in-app.
    await panel.locator('a', { hasText: 'test case' }).first().click();
    await expect(page).toHaveURL(/\/evaluations\/test-cases\/tc-stub/);
    // The panel (and its thread) survive navigation.
    await expect(page.locator('[data-testid="ask-panel"] [data-testid="ask-turn"]')).toHaveCount(3);
  });

  test('chip labels: "Ask" always; "Add to current question" only while a thread is open in the panel', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-chips'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await stubSessions(page, route);
    const stub = await stubAsk(page, 'Answer.');
    stub.release();

    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');

    // 1. Panel closed → only Ask.
    await selectText(page, 'HTTP 503');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveText(/^✨ Ask$/);
    await expect(page.locator('[data-testid="ask-chip-add"]')).toHaveCount(0);

    // 2. Start a question, move it to the panel → a new highlight offers BOTH.
    await page.locator('[data-testid="ask-chip"]').click();
    await page.locator('[data-testid="ask-open-in-panel"]').click();
    const panel = page.locator('[data-testid="ask-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="ask-context-chips"] [data-testid="ask-selection-quote"]')).toHaveCount(1);

    await selectText(page, 'since the last deploy');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveText(/^✨ Ask$/);
    const add = page.locator('[data-testid="ask-chip-add"]');
    await expect(add).toHaveText(/Add to current question/);
    await add.click();
    await expect(panel.locator('[data-testid="ask-context-chips"] [data-testid="ask-selection-quote"]')).toHaveCount(2);
    await expect(panel.locator('[data-testid="ask-context-chips"]')).toContainText('since the last deploy');

    // Ask the combined question: both highlights go up in one request.
    await panel.locator('[data-testid="ask-panel-composer-input"]').fill('Are these the same problem?');
    await page.keyboard.press('Enter');
    await expect(panel.locator('[data-testid="ask-turn-answer"]')).toContainText('Answer.');
    expect(stub.asks[0].selections).toHaveLength(2);

    // 3. "Ask" still starts a NEW question (popover) even with the panel open.
    await selectText(page, 'Find the root cause');
    await expect(page.locator('[data-testid="ask-chip-add"]')).toBeVisible();
    await page.locator('[data-testid="ask-chip"]').click();
    const popover = page.locator('[data-testid="ask-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover.locator('[data-testid="ask-selection-quote"]')).toContainText('Find the root cause');
    await expect(popover.locator('[data-testid="ask-turn"]')).toHaveCount(0);

    // 4. Nothing is sticky: a fresh page load with the panel closed is back to "Ask" only.
    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');
    await expect(page.locator('[data-testid="ask-panel"]')).toHaveCount(0);
    await selectText(page, 'HTTP 503');
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveText(/^✨ Ask$/);
    await expect(page.locator('[data-testid="ask-chip-add"]')).toHaveCount(0);
  });

  test('panel: drag handle resizes within limits and the width persists across reloads', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-resize'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await stubSessions(page, route);
    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');

    // Sidebar "Assistant" opens the panel over the current page (no navigation).
    await openPanelViaSidebar(page);
    const panel = page.locator('[data-testid="ask-panel"]');
    await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const widthOf = () => panel.evaluate((el) => el.getBoundingClientRect().width);
    const before = await widthOf();
    expect(Math.round(before)).toBe(560); // default
    const content = page.locator('[data-testid="ask-surface"]');
    expect(parseInt(await content.evaluate((el) => getComputedStyle(el).paddingRight), 10)).toBe(560);

    // Drag the left-edge handle 200px to the left → panel grows by 200.
    const handle = panel.locator('[data-testid="ask-panel-resize-handle"]');
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 300;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.move(x - 200, y, { steps: 5 });
    await page.mouse.up();
    expect(Math.round(await widthOf())).toBe(760);
    expect(parseInt(await content.evaluate((el) => getComputedStyle(el).paddingRight), 10)).toBe(760);
    expect(await page.evaluate(() => window.localStorage.getItem('ah.ask.panelWidth'))).toBe('760');

    // Dragging far right clamps at the minimum.
    const box2 = (await handle.boundingBox())!;
    await page.mouse.move(box2.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box2.x + 900, y, { steps: 10 });
    await page.mouse.up();
    expect(Math.round(await widthOf())).toBe(380);

    // Keyboard: ArrowLeft widens.
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    expect(Math.round(await widthOf())).toBe(404);

    // Persisted: reload, reopen → same width.
    await page.reload();
    await page.waitForSelector('[data-testid="sidebar"]');
    await openPanelViaSidebar(page);
    expect(Math.round(await widthOf())).toBe(404);
  });

  test('panel: sessions list has "This page" / "All" tabs, opens a pi session, links back to its page; /assistant and the nudge open the panel', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-sessions'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await stubSessions(page, route);
    const stub = await stubAsk(page, 'Nudged answer.');
    stub.release();

    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');
    await openPanelViaSidebar(page);
    const panel = page.locator('[data-testid="ask-panel"]');
    // No agent picker: there is exactly one assistant.
    await expect(panel.locator('select')).toHaveCount(0);
    await expect(panel).toContainText('Agent Health assistant · read-only');

    const list = panel.locator('[data-testid="ask-sessions-list"]');
    // History is local to this server — said so in the panel, with the directory in the tooltip.
    const note = list.locator('[data-testid="ask-sessions-local-note"]');
    await expect(note).toContainText('local only');
    await expect(note).toHaveAttribute('title', /Local history only: these threads are pi session files on this Agent Health server[\s\S]*ask-sessions/);
    // "This page" is the default tab: 1 of the 4 fixture sessions was asked on this route.
    await expect(list.locator('[data-testid="ask-sessions-tab-page"]')).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('[data-testid="ask-sessions-tab-page"]')).toContainText('This page (1)');
    await expect(list.locator('[data-testid="ask-session-item"]')).toHaveCount(1);
    await list.locator('[data-testid="ask-sessions-tab-all"]').click();
    await expect(list.locator('[data-testid="ask-session-item"]')).toHaveCount(4);
    // Identical questions on different pages stay apart.
    await expect(list.locator('[data-testid="ask-session-item"]', { hasText: 'Why did this case fail?' })).toHaveCount(2);

    await list.locator('[data-testid="ask-session-item"]', { hasText: 'What does this span do?' }).click();
    await expect(panel.locator('[data-testid="ask-turn-answer"]')).toContainText('It marks a permission wait.');
    await expect(panel.locator('[data-testid="ask-turn-meta"]')).toContainText('first token 1.2s');
    await panel.locator('[data-testid="ask-thread-page-link"]').click();
    await expect(page).toHaveURL(/\/compare\/b\?runs=x,y/);
    await expect(page.locator('[data-testid="ask-panel"]')).toBeVisible();

    // /assistant deep link → overview with the panel open.
    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="sidebar"]');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="ask-panel"]')).toBeVisible();
    await page.locator('[data-testid="ask-panel-close"]').click();
    await expect(page.locator('[data-testid="ask-panel"]')).toHaveCount(0);

    // The run-page nudge opens the panel and asks the route's first suggestion.
    // A real report (unknown ids redirect away from the run routes).
    const reportRes = await request.post('/api/storage/runs', {
      data: {
        testCaseId: tc.id, testCaseVersion: 1, agentKey: 'demo', agentName: 'Demo agent', modelId: 'demo', status: 'completed',
        passFailStatus: 'failed', metrics: { accuracy: 20 }, llmJudgeReasoning: 'The agent blamed the database.',
        trajectory: [{ id: 's1', timestamp: 1, type: 'response', content: 'The database is slow.' }], timestamp: new Date().toISOString(),
      },
    });
    expect(reportRes.ok()).toBe(true);
    const report = await reportRes.json();
    testData.run(report.id ?? report.run?.id);
    await page.evaluate(() => window.sessionStorage.clear());
    await page.goto(`/runs/${report.id ?? report.run?.id}`);
    await page.waitForSelector('[data-testid="sidebar"]');
    const nudge = page.locator('[data-testid="ask-nudge"]');
    await expect(nudge).toContainText('Want me to explain this run?');
    await nudge.click();
    await expect(page.locator('[data-testid="ask-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="ask-panel"] [data-testid="ask-turn-question"]')).toHaveText('Why did this run fail or succeed?');
    await expect(page.locator('[data-testid="ask-panel"] [data-testid="ask-turn-answer"]')).toContainText('Nudged answer.');
    await expect(nudge).toHaveCount(0);
  });

  test('assistant.enabled: false → no chip on selection, panel explains, composer disabled', async ({ page, request, testData }) => {
    const tc = await seedTestCase(request, uniqueTestName('ask-disabled'));
    testData.testCase(tc.id);
    const route = `/evaluations/test-cases/${tc.id}`;
    await page.route(/\/api\/ask\/status$/, (r) => r.fulfill({ json: { enabled: false, agent: { key: 'agent-health-assistant', name: 'Agent Health assistant' }, model: null, sessionsDir: '/srv/.agent-health/ask-sessions', maxConcurrent: 4, inFlight: 0, local: true } }));
    await page.route(/\/api\/ask\/sessions(\?|$)/, (r) => r.fulfill({ status: 404, json: { error: 'The assistant is disabled (assistant.enabled: false in agent-health.config.ts).' } }));
    let asked = 0;
    await page.route(/\/api\/ask(\/prepare)?$/, (r) => { asked += 1; return r.fulfill({ status: 404, json: { error: 'disabled' } }); });

    await page.goto(route);
    await page.waitForSelector('[data-testid="sidebar"]');
    await expect.poll(async () => page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/api/ask/status')))).toBe(true);
    await selectText(page, 'HTTP 503');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="ask-chip"]')).toHaveCount(0);

    await openPanelViaSidebar(page);
    const panel = page.locator('[data-testid="ask-panel"]');
    await expect(panel.locator('[data-testid="ask-disabled"]')).toContainText('assistant.enabled: false');
    await expect(panel.locator('[data-testid="ask-panel-composer-input"]')).toBeDisabled();
    expect(asked).toBe(0);
  });
});
