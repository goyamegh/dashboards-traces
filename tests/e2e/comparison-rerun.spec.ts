/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the comparison page's "Re-run comparison" button is enabled ONLY
 * when the compared runs cover the IDENTICAL test-case set. If they differ by
 * even one case, it must be disabled (re-running a comparison is ill-defined
 * when the runs aren't apples-to-apples).
 *
 * Deterministic: storage is mocked via page.route(); `fullyOverlapping` is
 * derived from each run's `results` keys (services/comparisonService.ts), so the
 * test just varies which test-case ids each run covers.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-rrA';
const RUN_B = 'eval-run-rrB';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// An eval-run covering the given test-case ids (results keyed by id → overlap).
const evalRun = (id: string, agent: string, repPrefix: string, tcIds: string[]) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-02-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: tcIds }], trigger: 'cli',
  testCaseSnapshots: tcIds.map(tc => ({ id: tc, version: 1, name: `Case ${tc}` })),
  results: Object.fromEntries(tcIds.map(tc => [tc, { reportId: `${repPrefix}-${tc}`, status: 'completed' }])),
  stats: { passed: tcIds.length, failed: 0, total: tcIds.length },
});
const report = (id: string, agent: string) => ({
  id, createdAt: '2026-02-01T10:00:00Z', agentId: agent, modelId: 'claude-opus-4-8',
  status: 'completed', passFailStatus: 'passed', metrics: { accuracy: 100 }, trajectory: [],
});

// aIds / bIds set per test before navigation.
let aIds: string[] = [];
let bIds: string[] = [];
let postCount = 0;
const postedBodies: any[] = [];

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const req = r.request();
    // POST = create+execute a run — stream back a `started` event (the runs
    // finish server-side; the client only needs the new runId to navigate).
    if (req.method() === 'POST') {
      postedBodies.push(JSON.parse(req.postData() || '{}'));
      const n = ++postCount;
      const body =
        `event: started\ndata: ${JSON.stringify({ runId: `new-run-${n}`, testCases: [] })}\n\n` +
        `event: completed\ndata: ${JSON.stringify({ type: 'completed' })}\n\n`;
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    }
    const u = req.url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo', 'ra', aIds), evalRun(RUN_B, 'pulsar', 'rb', bIds)], total: 2 });
    if (id === RUN_A) return json(r, evalRun(RUN_A, 'demo', 'ra', aIds));
    if (id === RUN_B) return json(r, evalRun(RUN_B, 'pulsar', 'rb', bIds));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    const m = u.match(/runs\/([^/?]+)/);
    return json(r, report(m ? decodeURIComponent(m[1]) : 'rep', 'demo'));
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  // deep-dive isn't under test here — 503 keeps it out of the way (no crash).
  await page.route('**/api/comparison/deep-dive', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

const btn = (page: import('@playwright/test').Page) => page.locator('[data-testid="rerun-comparison-btn"]');

test.describe('Comparison "Re-run comparison" button — gated on identical test cases', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page); });

  test('ENABLED when both runs cover the identical test-case set', async ({ page }) => {
    aIds = ['tc1', 'tc2', 'tc3'];
    bIds = ['tc1', 'tc2', 'tc3'];
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(btn(page)).toBeVisible({ timeout: 15000 });
    await expect(btn(page)).toBeEnabled();
    // The overlap banner confirms full comparability.
    await expect(page.locator('[data-testid="comparison-overlap-banner"][data-overlap="full"]')).toBeVisible();
  });

  test('DISABLED when the runs differ by even one test case', async ({ page }) => {
    aIds = ['tc1', 'tc2', 'tc3'];
    bIds = ['tc1', 'tc2', 'tc4']; // differs by one (tc3 vs tc4)
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(btn(page)).toBeVisible({ timeout: 15000 });
    await expect(btn(page)).toBeDisabled();
    // and the partial-overlap banner is shown (not the full one).
    await expect(page.locator('[data-testid="comparison-overlap-banner"][data-overlap="partial"]')).toBeVisible();
  });

  test('clicking it launches a run per config on the shared cases and opens the fresh comparison', async ({ page }) => {
    aIds = ['tc1', 'tc2'];
    bIds = ['tc1', 'tc2'];
    postCount = 0; postedBodies.length = 0;
    page.on('dialog', (d) => d.accept()); // accept the confirm()
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(btn(page)).toBeEnabled({ timeout: 15000 });
    await btn(page).click();
    // Navigates to the fresh comparison with the two new run ids.
    await page.waitForURL(/\/compare\?runs=new-run-\d+,new-run-\d+/, { timeout: 15000 });
    // Two runs launched, each pinned to the shared test-case set.
    expect(postedBodies).toHaveLength(2);
    for (const b of postedBodies) {
      expect(b.sources?.[0]?.type).toBe('test-case-ids');
      expect(b.sources?.[0]?.ids).toEqual(['tc1', 'tc2']);
    }
  });
});
