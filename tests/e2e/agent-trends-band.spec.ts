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

    // Chips render for both agents with a left-border color and accuracy value.
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_A}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_B}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_A}`)).toContainText('80.0%'); // latest run 8/10
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_B}`)).toContainText('70.0%'); // latest run 7/10

    // Accuracy metric (default): chart renders with real data, not the empty placeholder.
    await expect(page.getByTestId('agent-trends-chart')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart-empty')).toHaveCount(0);

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

    // Single run: chip still renders (latest accuracy + n/a delta)...
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_A}`)).toBeVisible();
    await expect(page.getByTestId(`agent-trends-chip-${AGENT_A}`)).toContainText('n/a');
    // ...but the chart area shows the "need at least 2 runs" placeholder, not a broken chart.
    await expect(page.getByTestId('agent-trends-empty-not-enough-runs')).toBeVisible();
    await expect(page.getByTestId('agent-trends-chart')).toHaveCount(0);
  });
});
