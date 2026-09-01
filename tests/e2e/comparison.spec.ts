/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect, Page } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * These tests used to click "the first View Latest / first h3" on whatever
 * benchmark happened to exist in shared storage — nondeterministic under
 * fullyParallel (another suite's single-run or mid-flight benchmark can be
 * the first card, leaving Compare disabled or the comparison page in an
 * empty state without its chrome), and vacuously green with no data at all.
 *
 * Each describe now seeds its OWN benchmark with two completed runs and
 * navigates straight to it; seeds are deleted by id afterwards.
 */

interface ComparisonSeed {
  benchmarkId: string;
  testCaseIds: string[];
}

async function seedBenchmarkWithTwoRuns(request: APIRequestContext): Promise<ComparisonSeed | null> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testCaseIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await request
      .post('/api/storage/test-cases', {
        data: {
          name: `e2e-comparison-tc-${i}-${stamp}`,
          category: 'E2E',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      })
      .catch(() => null);
    if (!r?.ok()) return null;
    const j = await r.json();
    testCaseIds.push(j.id || j.testCase?.id);
  }

  const bmRes = await request
    .post('/api/storage/benchmarks', {
      data: {
        name: `E2E Comparison BM ${stamp}`,
        description: 'comparison e2e seed',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    })
    .catch(() => null);
  if (!bmRes?.ok()) return null;
  const benchmarkId = (await bmRes.json()).id;

  const makeRun = (n: number) => ({
    id: `run-comparison-${n}-${stamp}`,
    name: `Comparison E2E Run ${n}`,
    agentKey: 'demo',
    modelId: 'demo-model',
    createdAt: new Date(Date.now() - (2 - n) * 60_000).toISOString(),
    status: 'completed',
    benchmarkVersion: 1,
    testCaseSnapshots: [],
    results: {
      [testCaseIds[0]]: { reportId: `rep-cmp-${n}-1-${stamp}`, status: 'completed', passFailStatus: 'passed' },
      [testCaseIds[1]]: { reportId: `rep-cmp-${n}-2-${stamp}`, status: 'completed', passFailStatus: n === 1 ? 'failed' : 'passed' },
    },
    stats: { passed: n === 1 ? 1 : 2, failed: n === 1 ? 1 : 0, pending: 0, errored: 0, total: 2 },
  });

  const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
  const bm = await get.json();
  const put = await request
    .put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [makeRun(1), makeRun(2)],
      },
    })
    .catch(() => null);
  if (!put?.ok()) return null;

  return { benchmarkId, testCaseIds };
}

async function deleteComparisonSeed(request: APIRequestContext, seed: ComparisonSeed | null): Promise<void> {
  if (!seed) return;
  await request.delete(`/api/storage/benchmarks/${encodeURIComponent(seed.benchmarkId)}`).catch(() => {});
  for (const id of seed.testCaseIds) {
    await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
  }
}

/** From the seeded benchmark's runs page: select both runs and open Compare. */
async function openComparison(page: Page, seed: ComparisonSeed): Promise<void> {
  await page.goto(`/benchmarks/${seed.benchmarkId}/runs`);
  await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 30000 });

  const selectAllButton = page.locator('button:has-text("Select All")');
  await expect(selectAllButton).toBeVisible({ timeout: 10000 });
  await selectAllButton.click();

  const compareButton = page.locator('button:has-text("Compare")').first();
  await expect(compareButton).toBeEnabled({ timeout: 10000 });
  await compareButton.click();
  await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
}

test.describe('Comparison Page', () => {
  let seed: ComparisonSeed | null = null;

  test.beforeAll(async ({ request }) => {
    seed = await seedBenchmarkWithTwoRuns(request);
  });

  test.afterAll(async ({ request }) => {
    await deleteComparisonSeed(request, seed);
    seed = null;
  });

  test('should navigate to comparison page from benchmark runs', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);
    await expect(page.locator('[data-testid="comparison-page"]')).toBeVisible();
  });

  test('should display Compare Runs title', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);
    await expect(page.locator('[data-testid="comparison-title"]')).toHaveText('Compare Runs');
  });

  test('breadcrumb navigates back out of the comparison', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);

    // The redesigned comparison page has no dedicated back button — its back
    // navigation is the breadcrumb (Home > Evaluations > Compare Runs).
    const crumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumb).toBeVisible();
    await crumb.locator('a:has-text("Evaluations")').click();
    await expect(page.locator('[data-testid="benchmarks-page"]')).toBeVisible({ timeout: 10000 });
  });

  test('should show run selector section', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);

    // The run selector is the "N of M runs" popover launcher; opening it must
    // list both seeded runs.
    const selector = page.locator('button', { hasText: /\d+ of \d+ runs/ }).first();
    await expect(selector).toBeVisible();
    await selector.click();
    await expect(page.locator('text=Comparison E2E Run 1').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Comparison E2E Run 2').first()).toBeVisible();
  });

  test('should not show a baseline selector', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);

    // Should NOT show a baseline selector (removed in favor of automatic oldest-run reference)
    const hasBaseline = await page.locator('text=Baseline').isVisible().catch(() => false);
    expect(hasBaseline).toBeFalsy();
  });
});

test.describe('Comparison Page - Metrics', () => {
  let seed: ComparisonSeed | null = null;

  test.beforeAll(async ({ request }) => {
    seed = await seedBenchmarkWithTwoRuns(request);
  });

  test.afterAll(async ({ request }) => {
    await deleteComparisonSeed(request, seed);
    seed = null;
  });

  test('should display run summary cards', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);

    // Should show run summary cards with metrics
    await expect(page.locator('text=/Pass Rate|Accuracy|Avg/').first()).toBeVisible({ timeout: 10000 });
  });

  test('should display comparison table', async ({ page }) => {
    test.skip(!seed, 'Comparison seed unavailable');
    await openComparison(page, seed!);

    // Should show use case comparison table or similar
    await expect(page.locator('text=/Use Case|Test Case|Status/').first()).toBeVisible({ timeout: 10000 });
  });
});
