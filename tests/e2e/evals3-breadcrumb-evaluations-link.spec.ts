/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the "Evaluations" breadcrumb crumb (shared across all evals3
 * pages via components/evals3/Breadcrumbs.tsx) used to link to
 * /evaluations/benchmarks. The owner wants it to link to the Evaluation
 * RUNS page (/evaluations/runs) instead — "Evaluations" is the run-centric
 * landing page, and Benchmarks is reached via its own crumb/link.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 breadcrumb — "Evaluations" crumb links to Evaluation Runs', () => {
  const check = async (page: import('@playwright/test').Page) => {
    const crumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumb).toBeVisible();
    const evalsLink = crumb.locator('a:has-text("Evaluations")');
    await expect(evalsLink).toBeVisible();
    await expect(evalsLink).toHaveAttribute('href', '/evaluations/runs');
  };

  test('Benchmarks page', async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 }).catch(() => null);
    await check(page);
  });

  test('Evaluation Runs page', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForLoadState('networkidle').catch(() => {});
    await check(page);
  });

  test('Test Cases page', async ({ page }) => {
    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 }).catch(() => null);
    await check(page);
  });
});
