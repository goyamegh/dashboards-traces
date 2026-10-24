/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the debug/dev-mode page-latency HUD (DebugLatencyHud + lib/pageLatency.ts).
 *
 * Owner's information design (2026-09-27): the collapsed pill is the CURRENT
 * page + ONE number (time-to-ready) + a colour dot; expanded shows plain
 * rows -- Page ready / First paint / API count + wall span + slowest
 * requests / "Slow steps on this page" (only when recorded) -- no legend,
 * no navigation history, no previous page, no summed API duration.
 * Everything resets on every route change.
 *
 * Debug mode is enabled through BOTH halves of the real mechanism (see
 * lib/debug.ts + App.tsx's `DebugStateSync`): `POST /api/debug` sets the
 * server-side truth (so the per-route-change sync in `App.tsx` doesn't
 * clobber it back to off a moment later), and `page.addInitScript`
 * pre-seeds the SAME `localStorage.agenteval_debug` key the Settings page
 * writes, so it's already correct at the very first render.
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const PILL = (route: string) => new RegExp(`^● ${route} · \\d+(\\.\\d)? (ms|s)$`);

function parseMs(s: string): number {
  const m = /(\d+(?:\.\d+)?) (ms|s)/.exec(s);
  if (!m) throw new Error(`no duration in ${JSON.stringify(s)}`);
  return m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}

/**
 * Sidebar click that also works once the nav is pinned to the icon rail (the
 * run inspector collapses it): hover the rail first so the flyout has finished
 * sliding open before the link is clicked.
 */
async function clickNav(page: Page, testId: string): Promise<void> {
  await page.getByTestId('sidebar-hover-zone').hover();
  await page.waitForTimeout(600);
  await page.getByTestId(testId).click();
}

/** The Settings page's Debug Mode switch (the ONLY user-facing way to turn the HUD on). */
async function flipDebugModeInSettings(page: Page, on: boolean): Promise<void> {
  const sw = page.locator('#debug-mode');
  await expect(sw).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute('aria-checked', on ? 'false' : 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', on ? 'true' : 'false');
}

test.describe('Debug latency HUD', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ request }) => {
    // Always leave debug mode off for the next test/spec sharing this server.
    await request.post('/api/debug', { data: { enabled: false } });
  });

  test('is absent when debug mode is off', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: false } });
    await page.goto('/evaluations/benchmarks');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });

  test('the pill is the current route + ONE time-to-ready number with a colour dot, and follows client-side navigation', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    // Wait for the benchmarks page to report itself ready ("…" → a number).
    await expect(pill).toHaveText(/^● benchmarks · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });
    await expect(pill).not.toContainText(/render|paint|api/i);
    await expect(page.getByTestId('debug-latency-hud-dot')).toHaveAttribute('data-band', /fast|ok|slow/);

    // Client-side nav (NOT page.goto -- a full reload would reset module state).
    await page.getByTestId('nav-evals3-runs').click();
    await expect(pill).toHaveText(/^● eval-runs · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });

    // Expanded: current page only -- nothing about the page we came from.
    await page.getByTestId('debug-latency-hud').click();
    const panel = page.getByTestId('debug-latency-hud-panel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText(/Last \d+ navigations|prev page|● benchmarks/);
  });

  test('expanded view: plain-language rows, the slowest requests, API wall span ≤ page ready, no legend, steps only when recorded', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toHaveText(/^● benchmarks · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });

    // Collapsed footprint: the panel is only rendered once expanded.
    await expect(page.getByTestId('debug-latency-hud-panel')).toHaveCount(0);
    await page.getByTestId('debug-latency-hud').click();
    const panel = page.getByTestId('debug-latency-hud-panel');
    await expect(panel).toBeVisible();

    const readyText = await page.getByTestId('debug-latency-hud-ready').innerText();
    const paintText = await page.getByTestId('debug-latency-hud-paint').innerText();
    const apiText = await page.getByTestId('debug-latency-hud-api').innerText();
    expect(readyText).toMatch(/^\d+(\.\d)? (ms|s)$/); // reported by the page itself (no ~ estimate marker)
    expect(paintText).toMatch(/^First paint\s*\d+(\.\d)? (ms|s)$/);
    expect(apiText).toMatch(/^API\s*\d+ requests? · \d+(\.\d)? (ms|s) wall$/);
    // The benchmarks list page fetches its data (at least one /api/* request)…
    const apiCount = parseInt(/(\d+) request/.exec(apiText)![1], 10);
    expect(apiCount).toBeGreaterThan(0);
    // …and the wall-clock span of those requests can never exceed the page's own time-to-ready.
    expect(parseMs(apiText.replace(/^API\s*\d+ requests? · /, ''))).toBeLessThanOrEqual(parseMs(readyText));

    // Slowest requests: method + templated path + duration, at most 5, ids collapsed.
    const requests = page.getByTestId('debug-latency-hud-request');
    const n = await requests.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
    await expect(requests.first()).toHaveText(/^(GET|POST|PUT|PATCH|DELETE) \/api\/\S+?\s*\d+(\.\d)? (ms|s)$/);
    for (const text of await requests.allInnerTexts()) expect(text).not.toMatch(/\?|[0-9a-f]{8}-[0-9a-f]{4}-/i);

    // No legend, no history, no "Operations", no summed api duration anywhere.
    const panelText = await panel.innerText();
    expect(panelText).not.toMatch(/< 50 ms|< 200 ms|≥ 200 ms|Last \d+ navigations|prev page|Operations|measurements|render /);
    // No steps recorded on this page → the section is absent, and there is no placeholder sentence for it.
    await expect(page.getByTestId('debug-latency-hud-operations')).toHaveCount(0);
    expect(panelText).not.toMatch(/Slow steps|No operation timings/);

    // Record a step through the console API (same lib/performance path the trace flow view uses)…
    await page.waitForFunction(() => typeof (window as any).__agentHealthPerf?.startMeasure === 'function');
    await page.evaluate(async () => {
      const api = (window as any).__agentHealthPerf;
      api.startMeasure('e2eSample.flowTransform');
      await new Promise(r => setTimeout(r, 60));
      api.endMeasure('e2eSample.flowTransform', false);
    });
    // …and the "Slow steps on this page" section appears with that step, still without a legend.
    const ops = page.getByTestId('debug-latency-hud-operations');
    await expect(ops).toContainText('Slow steps on this page');
    await expect(page.getByTestId('debug-latency-hud-op')).toHaveCount(1);
    await expect(page.getByTestId('debug-latency-hud-op')).toContainText('flowTransform');
    await expect(ops).not.toContainText(/< 50 ms|Clear/);

    // Line budget: 3 summary rows + ≤5 request rows + the steps block (≤3 rows).
    expect(await panel.locator(':scope > div').count()).toBeLessThanOrEqual(3 + 5 + 1);
    expect(await page.getByTestId('debug-latency-hud-op').count()).toBeLessThanOrEqual(3);

    // Everything is reset on the next route change: steps are gone, the pill is the new page's.
    await page.getByTestId('nav-evals3-runs').click();
    await expect(pill).toContainText('eval-runs', { timeout: 15_000 });
    await expect(page.getByTestId('debug-latency-hud-operations')).toHaveCount(0);
  });

  test('the former Performance Monitor overlay is gone; its DEBUG_PERFORMANCE flag now shows this HUD instead', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: false } });
    await page.addInitScript(() => {
      window.localStorage.removeItem('agenteval_debug');
      window.localStorage.setItem('DEBUG_PERFORMANCE', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    await expect(page.getByTestId('debug-latency-hud')).toBeVisible({ timeout: 15_000 });
    // Give the old overlay's 1 s localStorage poll (had it still been mounted) time to fire.
    await page.waitForTimeout(1500);
    await expect(page.getByText('Performance Monitor')).toHaveCount(0);
    await expect(page.getByText('No metrics recorded yet')).toHaveCount(0);
    await expect(page.locator('[data-testid="debug-latency-hud"]')).toHaveCount(1);
  });

  test('disappears again once debug mode is turned back off (next navigation)', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });
    await page.goto('/evaluations/benchmarks');
    await expect(page.getByTestId('debug-latency-hud')).toBeVisible({ timeout: 15_000 });

    await request.post('/api/debug', { data: { enabled: false } });
    // A client-side nav re-syncs localStorage from the server (App.tsx's
    // DebugStateSync, on every route change) before Layout starts the next
    // navigation window, so the HUD disappears without a full page reload.
    await page.getByTestId('nav-evals3-runs').click();
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });
});

/**
 * Owner report (2026-10-24): "why is the performance monitor not showing any
 * metrics after I turn it on?" -- the old overlay only ever listed
 * `lib/performance` step timings, which only two trace views recorded, so on
 * Benchmarks / Runs / Inspector it stayed empty. These tests drive the REAL
 * user path (the Settings page's Debug Mode switch, not an API shortcut) and
 * real-shaped data: a benchmark whose three runs share one name, a held
 * (slow) second-step request, and 5+ pages navigated client-side, asserting
 * the pill shows the right page and a real number on every one of them.
 */
test.describe('Debug latency HUD — Settings toggle + real-shaped pages', () => {
  test.describe.configure({ mode: 'serial' });

  const tracker = createTestDataTracker();
  const SAME_NAME = uniqueTestName('hud-same-name');
  let benchmarkId: string | null = null;
  let runIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const tcIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: { name: uniqueTestName(`hud-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const tcId = j.id || j.testCase?.id;
      tracker.testCase(tcId);
      tcIds.push(tcId);
    }
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('hud-benchmark'),
        description: 'latency HUD E2E',
        testCaseIds: tcIds, runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: tcIds }],
      },
    });
    if (!bmRes.ok()) return;
    const id = (await bmRes.json()).id as string;
    tracker.benchmark(id);
    const bm = await (await request.get(`/api/storage/benchmarks/${id}`)).json();
    const snaps = tcIds.map(tc => ({ id: tc, version: 1, name: tc }));
    const now = Date.now();
    // Three runs with IDENTICAL names (real data has these: re-runs of the same config).
    runIds = [0, 1, 2].map(i => `run-hud-${now}-${i}`);
    const runs = runIds.map((rid, i) => ({
      id: rid, name: SAME_NAME, agentKey: 'demo', modelId: 'demo-model',
      createdAt: new Date(now - (i + 1) * 86_400_000).toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: snaps,
      results: Object.fromEntries(tcIds.map(tc => [tc, { reportId: `report-hud-${rid}-${tc}`, status: 'completed', passFailStatus: 'passed' }])),
    }));
    const put = await request.put(`/api/storage/benchmarks/${id}`, {
      data: { name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds, runs },
    });
    if (!put.ok()) return;
    benchmarkId = id;
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/debug', { data: { enabled: false } });
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('turning on the Settings "Debug Mode" switch shows the HUD at once, and every page visited afterwards gets a real number', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed the benchmark (storage not configured?)');

    await request.post('/api/debug', { data: { enabled: false } });
    await page.goto('/settings');
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);

    // Hold the Runs tab's benchmark fetch: a slow second-step load is the
    // shape the owner actually hits, and it must show up in the number.
    const HOLD_MS = 1500;
    await page.route(`**/api/storage/benchmarks/${benchmarkId}?*`, async route => {
      await new Promise(r => setTimeout(r, HOLD_MS));
      await route.continue();
    });

    await flipDebugModeInSettings(page, true);
    // Visible within the 1 s activation poll, before any navigation: tells
    // the user what to do instead of sitting there empty.
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toBeVisible({ timeout: 5_000 });
    await expect(pill).toHaveText(/navigate to start measuring/);
    // The Settings blurb describes THIS HUD, not the removed overlay.
    await expect(page.getByText(/Latency HUD:/)).toBeVisible();
    await expect(page.getByText(/Performance Monitoring:|metrics overlay/)).toHaveCount(0);

    // 1. Benchmarks list.
    await page.getByTestId('nav-evals3-benchmarks').click();
    await expect(pill).toHaveText(PILL('benchmarks'), { timeout: 15_000 });
    await expect(page.getByTestId('debug-latency-hud-dot')).toHaveAttribute('data-band', /fast|ok|slow/);

    // 2. Benchmark Runs tab (held request): number ≥ the hold, dot not green, request listed.
    await page.locator('tr', { hasText: 'hud-benchmark' }).first().click();
    await expect(pill).toHaveText(PILL('benchmark-runs'), { timeout: 20_000 });
    const runsReady = parseMs((await pill.innerText()));
    expect(runsReady).toBeGreaterThanOrEqual(HOLD_MS);
    await expect(page.getByTestId('debug-latency-hud-dot')).toHaveAttribute('data-band', /ok|slow/);
    await page.getByTestId('debug-latency-hud').click(); // pin
    const held = page.getByTestId('debug-latency-hud-request').filter({ hasText: '/api/storage/benchmarks/:id' });
    await expect(held.first()).toBeVisible();
    expect(parseMs(await held.first().innerText())).toBeGreaterThanOrEqual(HOLD_MS);
    const panelText = await page.getByTestId('debug-latency-hud-panel').innerText();
    expect(panelText).not.toContain(benchmarkId!); // ids collapsed to :id
    expect(panelText).not.toMatch(/benchmarks · /); // nothing about the previous page
    await page.getByTestId('debug-latency-hud').click(); // un-pin

    // Runs tab: three rows, one name -- the HUD must not depend on names being unique.
    await page.getByRole('tab', { name: /^Runs/ }).click();
    await expect(page.getByTestId('run-row')).toHaveCount(3, { timeout: 15_000 });
    expect((await page.getByTestId('run-name-link').allInnerTexts()).map(t => t.trim())).toEqual([SAME_NAME, SAME_NAME, SAME_NAME]);
    // The tab switch is a navigate() that keeps the route key and does NOT
    // reload the page, so the page never reports ready again: the pill must
    // still settle on a number (estimate), never sit on "…".
    await expect(pill).toHaveText(PILL('benchmark-runs'), { timeout: 15_000 });
    await page.getByTestId('debug-latency-hud').click();
    await expect(page.getByTestId('debug-latency-hud-ready')).toContainText('~');
    await page.getByTestId('debug-latency-hud').click();

    // 3. Run inspector (client-side, via the first of three identically named runs).
    await page.getByTestId('run-name-link').first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runIds[0]}/inspect`));
    await expect(pill).toHaveText(PILL('run-inspector'), { timeout: 20_000 });

    // 4. Evaluation Runs list (the inspector collapses the sidebar to an icon
    //    rail with a hover flyout, so use its breadcrumb link instead).
    await page.getByRole('link', { name: 'Evaluations', exact: true }).first().click();
    await expect(page).toHaveURL(/\/evaluations\/runs$/);
    await expect(pill).toHaveText(PILL('eval-runs'), { timeout: 20_000 });

    // 5. Agent Traces (no observability backend on this server → the page still reports ready).
    await clickNav(page, 'nav-agent-traces');
    await expect(pill).toHaveText(PILL('traces'), { timeout: 20_000 });

    // 6. A page that does NOT instrument itself still gets an estimate (~), not an empty HUD.
    await clickNav(page, 'nav-overview');
    await expect(pill).toHaveText(PILL('/'), { timeout: 20_000 });
    await page.getByTestId('debug-latency-hud').click();
    await expect(page.getByTestId('debug-latency-hud-ready')).toContainText('~');
    await page.getByTestId('debug-latency-hud').click();

    // Off again from Settings: gone within the poll, no navigation needed.
    await clickNav(page, 'nav-settings');
    await flipDebugModeInSettings(page, false);
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0, { timeout: 5_000 });
  });

  test('Compare page reports ready too (comparison route) and a reload keeps the HUD on', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed the benchmark (storage not configured?)');
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });
    await page.goto(`/compare/${benchmarkId}?runs=${runIds[0]},${runIds[1]}`);
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toHaveText(PILL('comparison'), { timeout: 30_000 });
    // Full reload (fresh module state) on an instrumented page: measured again, not stuck on "…".
    await page.reload();
    await expect(pill).toHaveText(PILL('comparison'), { timeout: 30_000 });
  });
});
