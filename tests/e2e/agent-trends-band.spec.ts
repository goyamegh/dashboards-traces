/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trends band (landing-page "Agent trends" — replaces Performance Trends).
 *
 * Seeds a benchmark with runs for two agents directly via
 * POST /api/storage/benchmarks (runs embedded, stats set explicitly) so
 * accuracy/pass-rate render without needing full EvaluationReport docs or
 * OpenSearch trace data. Cost/tokens are trace-derived (see
 * lib/agentTrends.ts) and intentionally NOT seeded here — this also
 * exercises the "no cost/token data available" empty state for the
 * Cost/Tokens metric toggles.
 */

import { test, expect } from './fixtures/test-fixtures';

// Distinct ids per test — fullyParallel:true can run tests in this file
// concurrently, so sharing an id would race two tests' create/delete calls
// against the same document.
const BENCHMARK_ID_MULTI = 'e2e-trends-band-bm-multi';
const BENCHMARK_ID_SINGLE = 'e2e-trends-band-bm-single';
const BENCHMARK_ID_VISIBILITY = 'e2e-trends-band-bm-visibility';
const BENCHMARK_ID_MOBILE = 'e2e-trends-band-bm-mobile';
const AGENT_A = 'e2e-trends-agent-alpha';
const AGENT_B = 'e2e-trends-agent-beta';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
      if (b.name?.startsWith('E2E Trends Band Benchmark')) {
        await request.delete(`/api/storage/benchmarks/${b.id}`).catch(() => {});
      }
    }
  } catch {
    // best-effort
  }
}

test.describe('Agent Trends band', () => {
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
    await page.request.delete(`/api/storage/benchmarks/${BENCHMARK_ID_MULTI}`).catch(() => {});
    await page.request.delete(`/api/storage/benchmarks/${BENCHMARK_ID_SINGLE}`).catch(() => {});
    await page.request.delete(`/api/storage/benchmarks/${BENCHMARK_ID_VISIBILITY}`).catch(() => {});
  });

  test('renders chips + chart for a multi-agent benchmark, and the metric toggle switches views', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: BENCHMARK_ID_MULTI,
        name: 'E2E Trends Band Benchmark',
        description: 'seeded by agent-trends-band.spec.ts',
        testCaseIds: [],
        runs: [
          run('e2e-trends-a1', AGENT_A, daysAgo(9), 6, 10),
          run('e2e-trends-a2', AGENT_A, daysAgo(1), 8, 10),
          run('e2e-trends-b1', AGENT_B, daysAgo(8), 9, 10),
          run('e2e-trends-b2', AGENT_B, daysAgo(2), 7, 10),
        ],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    const band = page.getByTestId('agent-trends-band');
    await expect(band).toBeVisible({ timeout: 30000 });

    // Scope explicitly to our seeded benchmark (shared storage may have other
    // benchmarks/runs; the default "most recently active" selection is not
    // asserted here to keep this test independent of unrelated data).
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends Band Benchmark', exact: true }).click();
    await page.getByTestId('agent-trends-range-select').click();
    await page.getByRole('option', { name: 'Last 90 days' }).click();

    // Opening the Agents drawer lists both agents with a color swatch,
    // accuracy value, and (since no trace data was seeded) honest — cost/tokens.
    await page.getByTestId('agent-trends-agents-toggle').click();
    await expect(page.getByTestId('agent-trends-agents-menu')).toBeVisible();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_A}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_B}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_A}`)).toContainText('80.0%'); // latest run 8/10
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_B}`)).toContainText('70.0%'); // latest run 7/10
    await page.getByTestId('agent-trends-agents-toggle').click(); // close the drawer

    // Accuracy metric (default): chart renders with real data, not the empty placeholder.
    await expect(page.getByTestId('agent-trends-chart')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart-empty')).toHaveCount(0);

    // Numbers are drawn directly on the data points (SVG-rendered labels) —
    // both agents' latest points are pinned with "name: value" regardless of
    // any overlap-decluttering applied to the older, denser dots.
    const chartLabels = page.getByTestId('agent-trends-chart').locator('text');
    await expect(chartLabels.filter({ hasText: `${AGENT_A}: 80.0%` })).toHaveCount(1);
    await expect(chartLabels.filter({ hasText: `${AGENT_B}: 70.0%` })).toHaveCount(1);

    // Toggle to Cost/run: no trace metrics were seeded, so the chart shows the
    // "no cost data" placeholder rather than a broken/empty chart.
    await page.getByTestId('agent-trends-metric-cost').click();
    await expect(page.getByTestId('agent-trends-chart-empty')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart-empty')).toContainText('cost');

    // Toggle to Tokens: same placeholder behavior.
    await page.getByTestId('agent-trends-metric-tokens').click();
    await expect(page.getByTestId('agent-trends-chart-empty')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart-empty')).toContainText('tokens');

    // Back to Accuracy: chart returns.
    await page.getByTestId('agent-trends-metric-accuracy').click();
    await expect(page.getByTestId('agent-trends-chart')).toBeVisible();
  });

  test('shows a friendly placeholder with fewer than 2 runs in scope, never a broken chart', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: BENCHMARK_ID_SINGLE,
        name: 'E2E Trends Band Benchmark (single run)',
        testCaseIds: [],
        runs: [run('e2e-trends-only-one', AGENT_A, daysAgo(1), 5, 10)],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('agent-trends-band')).toBeVisible({ timeout: 30000 });

    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends Band Benchmark (single run)', exact: true }).click();

    // Single run: agents drawer still lists the agent (latest accuracy + n/a delta)...
    await page.getByTestId('agent-trends-agents-toggle').click();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_A}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_A}`)).toContainText('n/a');
    await page.getByTestId('agent-trends-agents-toggle').click();
    // ...but the chart area shows the "need at least 2 runs" placeholder, not a broken chart.
    await expect(page.getByTestId('agent-trends-empty-not-enough-runs')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart')).toHaveCount(0);
  });

  test('unchecking an agent in the drawer hides its series from the chart', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: BENCHMARK_ID_VISIBILITY,
        name: 'E2E Trends Band Benchmark (visibility toggle)',
        description: 'seeded by agent-trends-band.spec.ts',
        testCaseIds: [],
        runs: [
          run('e2e-trends-vis-a1', AGENT_A, daysAgo(9), 6, 10),
          run('e2e-trends-vis-a2', AGENT_A, daysAgo(1), 8, 10),
          run('e2e-trends-vis-b1', AGENT_B, daysAgo(8), 9, 10),
          run('e2e-trends-vis-b2', AGENT_B, daysAgo(2), 7, 10),
        ],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('agent-trends-band')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends Band Benchmark (visibility toggle)', exact: true }).click();
    await page.getByTestId('agent-trends-range-select').click();
    await page.getByRole('option', { name: 'Last 90 days' }).click();
    await expect(page.getByTestId('agent-trends-chart')).toBeVisible();

    const chartLabels = page.getByTestId('agent-trends-chart').locator('text');
    await expect(chartLabels.filter({ hasText: `${AGENT_B}: 70.0%` })).toHaveCount(1);

    await page.getByTestId('agent-trends-agents-toggle').click();
    await page.getByTestId(`agent-trends-agent-visibility-${AGENT_B}`).click();
    await page.getByTestId('agent-trends-agents-toggle').click();

    // Agent B's pinned latest-point label (and its dots) are gone from the
    // chart once hidden; Agent A's series is unaffected.
    await expect(chartLabels.filter({ hasText: `${AGENT_B}: 70.0%` })).toHaveCount(0);
    await expect(chartLabels.filter({ hasText: `${AGENT_A}: 80.0%` })).toHaveCount(1);
  });
});

test.describe('Agent Trends band (mobile, 375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`/api/storage/benchmarks/${BENCHMARK_ID_MOBILE}`).catch(() => {});
  });

  test('the Agents drawer opens without horizontal overflow and lists agent rows', async ({ page }) => {
    const createResp = await page.request.post('/api/storage/benchmarks', {
      data: {
        id: BENCHMARK_ID_MOBILE,
        name: 'E2E Trends Band Benchmark (mobile)',
        description: 'seeded by agent-trends-band.spec.ts',
        testCaseIds: [],
        runs: [
          run('e2e-trends-a1', AGENT_A, daysAgo(9), 6, 10),
          run('e2e-trends-a2', AGENT_A, daysAgo(1), 8, 10),
          run('e2e-trends-b1', AGENT_B, daysAgo(8), 9, 10),
          run('e2e-trends-b2', AGENT_B, daysAgo(2), 7, 10),
        ],
      },
    });
    expect(createResp.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('agent-trends-band')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('agent-trends-benchmark-select').click();
    await page.getByRole('option', { name: 'E2E Trends Band Benchmark (mobile)', exact: true }).click();

    await page.getByTestId('agent-trends-agents-toggle').click();
    const menu = page.getByTestId('agent-trends-agents-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId(`agent-trends-agents-menu-row-${AGENT_A}`)).toBeVisible();

    // The drawer must fit within the viewport, not force horizontal scroll.
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1); // +1px rounding tolerance

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(376);
  });
});
