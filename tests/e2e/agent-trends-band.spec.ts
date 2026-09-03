/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trends band v3 (landing-page "Agent trends" \u2014 ranked dot plot).
 *
 * Seeds benchmarks with runs for two agents directly via
 * POST /api/storage/benchmarks (runs embedded, stats set explicitly) so
 * accuracy/pass-rate render without needing full EvaluationReport docs or
 * OpenSearch trace data. Cost/tokens are trace-derived (see
 * lib/agentTrends.ts) and intentionally NOT seeded here \u2014 this also
 * exercises the "no cost/token data available" empty state for the
 * Cost/Tokens metric toggles.
 *
 * Distinct ids per test \u2014 fullyParallel:true can run tests in this file
 * concurrently, so sharing an id would race two tests' create/delete calls
 * against the same document.
 */

import { test, expect } from './fixtures/test-fixtures';

const AGENT_A = 'e2e-trends-v3-agent-alpha';
const AGENT_B = 'e2e-trends-v3-agent-beta';
const AGENT_OLD = 'e2e-trends-v3-agent-gamma';

const ALL_BENCHMARK_IDS = [
  'e2e-trends-v3-bm-rank',
  'e2e-trends-v3-bm-switch-new',
  'e2e-trends-v3-bm-switch-old',
  'e2e-trends-v3-bm-single',
  'e2e-trends-v3-bm-layout',
  'e2e-trends-v3-bm-mobile',
];

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Guaranteed newer than anything seeded via daysAgo() \u2014 used to make "defaults to most-recent" assertions robust against unrelated shared-cluster data. */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function run(id: string, agentKey: string, createdAt: string, passed: number, total: number) {
  return {
    id,
    name: id,
    agentKey,
    modelId: 'e2e-model',
    createdAt,
    status: 'completed',
    results: {},
    stats: { passed, failed: total - passed, pending: 0, total },
  };
}

// Defensive sweep: delete any stray benchmark left over from a previous
// interrupted/flaky run of this spec (shared-cluster storage means these
// don't disappear on their own between local runs).
async function cleanupStrayBenchmarks(request: import('@playwright/test').APIRequestContext) {
  try {
    const res = await request.get('/api/storage/benchmarks');
    if (!res.ok()) return;
    const body = await res.json();
    const all: Array<{ id: string; name?: string }> = Array.isArray(body) ? body : (body.benchmarks ?? []);
    for (const b of all) {
      if (b.name?.startsWith('E2E Trends v3 Benchmark') || ALL_BENCHMARK_IDS.includes(b.id)) {
        await request.delete(`/api/storage/benchmarks/${b.id}`).catch(() => {});
      }
    }
  } catch {
    // best-effort
  }
}

test.describe('Agent Trends band v3 (ranked dot plot)', () => {
  test.beforeAll(async ({ request }) => {
    await cleanupStrayBenchmarks(request);
  });

  test.afterAll(async ({ request }) => {
    await cleanupStrayBenchmarks(request);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const pageReady = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(pageReady).toBeVisible({ timeout: 30000 });
  });

  test.afterEach(async ({ page }) => {
    for (const id of ALL_BENCHMARK_IDS) {
      await page.request.delete(`/api/storage/benchmarks/${id}`).catch(() => {});
    }
  });

  test('ranks agents by latest score, renders latest+history dots, carries numbers on hover, and click opens the run report', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: 'e2e-trends-v3-bm-rank',
        name: 'E2E Trends v3 Benchmark (rank)',
        description: 'seeded by agent-trends-band.spec.ts',
        testCaseIds: [],
        runs: [
          run('e2e-v3-a1', AGENT_A, daysAgo(9), 6, 10), // history: 60%
          run('e2e-v3-a2', AGENT_A, daysAgo(1), 8, 10), // latest: 80%
          run('e2e-v3-b1', AGENT_B, daysAgo(8), 9, 10), // history: 90%
          run('e2e-v3-b2', AGENT_B, daysAgo(2), 7, 10), // latest: 70%
        ],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    const band = page.getByTestId('agent-trends-band');
    await expect(band).toBeVisible({ timeout: 30000 });

    // Scope explicitly to our seeded benchmark (shared storage may have other
    // benchmarks/runs with even more recent activity).
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends v3 Benchmark (rank)', exact: true }).click();

    await expect(page.getByTestId('agent-dot-plot')).toBeVisible();
    await expect(page.getByTestId('agent-dot-plot-empty')).toHaveCount(0);

    // Ranked order: agent A (latest 80%) outranks agent B (latest 70%) —
    // its row renders BEFORE agent B's in DOM order (best on top).
    const rowIds = await page.locator('[data-testid^="agent-dot-plot-row-"]').evaluateAll(
      els => els.map(el => el.getAttribute('data-testid')),
    );
    expect(rowIds.indexOf(`agent-dot-plot-row-${AGENT_A}`)).toBeLessThan(rowIds.indexOf(`agent-dot-plot-row-${AGENT_B}`));

    // Both agents have 2 runs on this benchmark: one large "latest" dot + one small "history" dot each.
    const latestA = page.getByTestId(`agent-dot-plot-latest-${AGENT_A}`);
    await expect(latestA).toBeVisible();
    await expect(page.getByTestId(`agent-dot-plot-history-${AGENT_A}-0`)).toBeVisible();
    await expect(page.getByTestId(`agent-dot-plot-latest-${AGENT_B}`)).toBeVisible();
    await expect(page.getByTestId(`agent-dot-plot-history-${AGENT_B}-0`)).toBeVisible();

    // No on-point label clutter: the dot itself carries no visible text —
    // the number lives in the native hover title instead.
    expect((await latestA.textContent())?.trim()).toBe('');
    const title = await latestA.getAttribute('title');
    expect(title).toContain('80.0%');
    expect(title).toContain(AGENT_A);

    // Metric toggle: no trace metrics were seeded, so Cost/Tokens show the
    // honest "no data" placeholder rather than a broken/empty chart.
    await page.getByTestId('agent-trends-metric-cost').click();
    await expect(page.getByTestId('agent-dot-plot-empty')).toBeVisible();
    await expect(page.getByTestId('agent-dot-plot-empty')).toContainText('cost');
    await page.getByTestId('agent-trends-metric-accuracy').click();
    await expect(page.getByTestId('agent-dot-plot')).toBeVisible();

    // Clicking a dot opens that run's report.
    await latestA.click();
    await expect(page).toHaveURL(/\/evaluations\/benchmarks\/e2e-trends-v3-bm-rank\/runs\/e2e-v3-a2\/inspect$/);
  });

  test('benchmark selector defaults to the most-recently-active benchmark, and can switch to an older one', async ({ page }) => {
    // Seeded with a future timestamp so it's guaranteed the most recent run
    // in the whole (shared) cluster, regardless of unrelated data.
    const createNew = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: 'e2e-trends-v3-bm-switch-new',
        name: 'E2E Trends v3 Benchmark (switch-new)',
        testCaseIds: [],
        runs: [run('e2e-v3-new-1', AGENT_A, hoursFromNow(1), 8, 10)],
      },
    });
    expect(createNew.ok()).toBeTruthy();
    const createOld = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: 'e2e-trends-v3-bm-switch-old',
        name: 'E2E Trends v3 Benchmark (switch-old)',
        testCaseIds: [],
        runs: [run('e2e-v3-old-1', AGENT_OLD, daysAgo(20), 5, 10)],
      },
    });
    expect(createOld.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('agent-trends-band')).toBeVisible({ timeout: 30000 });

    // Default scope, with no manual selection: the benchmark with the most recent run.
    await expect(page.getByTestId('agent-trends-scope-label')).toContainText('E2E Trends v3 Benchmark (switch-new)');
    await expect(page.getByTestId(`agent-dot-plot-row-${AGENT_A}`)).toBeVisible();

    // Switching the selector to the older benchmark shows ITS agents instead.
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends v3 Benchmark (switch-old)', exact: true }).click();
    await expect(page.getByTestId('agent-trends-scope-label')).toContainText('E2E Trends v3 Benchmark (switch-old)');
    await expect(page.getByTestId(`agent-dot-plot-row-${AGENT_OLD}`)).toBeVisible();
    await expect(page.getByTestId(`agent-dot-plot-row-${AGENT_A}`)).toHaveCount(0);
  });

  test('a single run is a fully valid row — latest dot only, no history dot, never a broken chart', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: 'e2e-trends-v3-bm-single',
        name: 'E2E Trends v3 Benchmark (single)',
        testCaseIds: [],
        runs: [run('e2e-v3-only-one', AGENT_A, daysAgo(1), 5, 10)],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('agent-trends-band')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends v3 Benchmark (single)', exact: true }).click();

    await expect(page.getByTestId(`agent-dot-plot-latest-${AGENT_A}`)).toBeVisible();
    await expect(page.getByTestId(`agent-dot-plot-history-${AGENT_A}-0`)).toHaveCount(0);
    await expect(page.getByTestId('agent-dot-plot-empty')).toHaveCount(0);
  });

  test('desktop (1280px): Agent Trends and Agents Needing Improvement render side by side', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: 'e2e-trends-v3-bm-layout',
        name: 'E2E Trends v3 Benchmark (layout)',
        testCaseIds: [],
        runs: [run('e2e-v3-layout-1', AGENT_A, daysAgo(1), 5, 10)],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    const trendsBand = page.getByTestId('agent-trends-band');
    const needsImprovement = page.getByTestId('needs-improvement-card');
    await expect(trendsBand).toBeVisible({ timeout: 30000 });
    await expect(needsImprovement).toBeVisible();

    const trendsBox = await trendsBand.boundingBox();
    const needsBox = await needsImprovement.boundingBox();
    expect(trendsBox).not.toBeNull();
    expect(needsBox).not.toBeNull();

    // Side by side: roughly the same top (same grid row) and the trends
    // band strictly to the LEFT of the needs-improvement card.
    expect(Math.abs(trendsBox!.y - needsBox!.y)).toBeLessThanOrEqual(4);
    expect(trendsBox!.x + trendsBox!.width).toBeLessThanOrEqual(needsBox!.x + 1);
  });

  test.describe('mobile (390px)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('Agent Trends and Agents Needing Improvement stack, and the history drawer opens without horizontal overflow', async ({ page }) => {
      const createResp = await page.request.post('/api/storage/benchmarks', {
        data: {
          id: 'e2e-trends-v3-bm-mobile',
          name: 'E2E Trends v3 Benchmark (mobile)',
          description: 'seeded by agent-trends-band.spec.ts',
          testCaseIds: [],
          runs: [
            run('e2e-v3-mob-a1', AGENT_A, daysAgo(9), 6, 10),
            run('e2e-v3-mob-a2', AGENT_A, daysAgo(1), 8, 10),
            run('e2e-v3-mob-b1', AGENT_B, daysAgo(8), 9, 10),
            run('e2e-v3-mob-b2', AGENT_B, daysAgo(2), 7, 10),
          ],
        },
      });
      expect(createResp.ok()).toBeTruthy();

      await page.goto('/');
      const trendsBand = page.getByTestId('agent-trends-band');
      const needsImprovement = page.getByTestId('needs-improvement-card');
      await expect(trendsBand).toBeVisible({ timeout: 30000 });
      await expect(needsImprovement).toBeVisible();

      // Stacked (not side by side): needs-improvement renders BELOW the trends band.
      const trendsBox = await trendsBand.boundingBox();
      const needsBox = await needsImprovement.boundingBox();
      expect(trendsBox).not.toBeNull();
      expect(needsBox).not.toBeNull();
      expect(needsBox!.y).toBeGreaterThanOrEqual(trendsBox!.y + trendsBox!.height - 1);

      await page.getByTestId('agent-trends-benchmark-select').click();
      await page.getByRole('option', { name: 'E2E Trends v3 Benchmark (mobile)', exact: true }).click();

      await page.getByTestId('agent-trends-agents-toggle').click();
      const menu = page.getByTestId('agent-trends-agents-menu');
      await expect(menu).toBeVisible();
      await expect(page.getByTestId(`agent-trend-row-${AGENT_A}`)).toBeVisible();

      // The drawer must fit within the viewport, not force horizontal scroll.
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1); // +1px rounding tolerance

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(391);
    });
  });
});
