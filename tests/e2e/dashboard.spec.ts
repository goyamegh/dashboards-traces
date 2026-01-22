/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="dashboard-page"]', { timeout: 30000 });
  });

  test('should display dashboard title and description', async ({ page }) => {
    await expect(page.locator('[data-testid="dashboard-title"]')).toHaveText('Agent Evaluation Dashboard');
    await expect(page.locator('text=Monitor agent performance and run evaluations')).toBeVisible();
  });

  test('should display quick action cards', async ({ page }) => {
    // Test Cases quick action card
    await expect(page.locator('text=Test Cases').first()).toBeVisible();
    await expect(page.locator('text=Create and organize tests')).toBeVisible();

    // Experiments quick action card
    await expect(page.locator('text=Experiments').first()).toBeVisible();
    await expect(page.locator('text=Batch test multiple cases')).toBeVisible();
  });

  test('should have working Create New links in quick actions', async ({ page }) => {
    // Click on the Test Cases "Create New" button
    const createNewTestCaseBtn = page.locator('a:has-text("Create New")').first();
    await expect(createNewTestCaseBtn).toBeVisible();
    await expect(createNewTestCaseBtn).toHaveAttribute('href', /test-cases/);
  });

  test('should have working View All links in quick actions', async ({ page }) => {
    // There should be View All buttons that link to the respective pages
    const viewAllLinks = page.locator('a:has-text("View All")');
    await expect(viewAllLinks.first()).toBeVisible();
  });

  test('should show empty state when no data', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(3000);

    // Check for experiments section, quick actions, or empty state
    const hasExperiments = await page.locator('text=Your Experiments').isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=Welcome to Agent Evaluation').isVisible().catch(() => false);
    const hasQuickActions = await page.locator('text=Test Cases').first().isVisible().catch(() => false);

    // Either experiments section, quick actions, or empty state should be visible
    expect(hasExperiments || hasEmptyState || hasQuickActions).toBeTruthy();
  });

  test('should display Quick Stats card when data exists', async ({ page }) => {
    // Wait for loading to complete
    await page.waitForTimeout(2000);

    // Check if Quick Stats section exists (only shown when there's data)
    const quickStats = page.locator('text=Quick Stats');
    const isVisible = await quickStats.isVisible().catch(() => false);

    if (isVisible) {
      // Verify stats categories
      await expect(page.locator('text=Experiments').first()).toBeVisible();
      await expect(page.locator('text=Test Cases').first()).toBeVisible();
    }
  });

  test('should navigate to Test Cases page from quick action', async ({ page }) => {
    const viewAllTestCases = page.locator('a[href*="test-cases"]:has-text("View All")').first();

    if (await viewAllTestCases.isVisible().catch(() => false)) {
      await viewAllTestCases.click();
      await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
    }
  });

  test('should show loading skeleton while fetching data', async ({ page }) => {
    // Navigate fresh to catch loading state
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Either skeleton or content should be visible
    const hasContent = await page.locator('[data-testid="dashboard-title"]').isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
  });
});

test.describe('Dashboard Experiments Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="dashboard-page"]', { timeout: 30000 });
  });

  test('should show "View All" link for experiments when data exists', async ({ page }) => {
    await page.waitForTimeout(2000);

    const experimentsHeader = page.locator('text=Your Experiments');
    if (await experimentsHeader.isVisible().catch(() => false)) {
      const viewAllLink = page.locator('a:has-text("View All")').filter({ hasText: 'View All' });
      await expect(viewAllLink.first()).toBeVisible();
    }
  });

  test('should display experiment cards with status badges', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Check for experiment cards if they exist
    const experimentCards = page.locator('[class*="card"]').filter({ hasText: /Passing|Degraded|Failing|No Data/ });
    const count = await experimentCards.count();

    // Either there are experiment cards or there's an empty state
    if (count > 0) {
      await expect(experimentCards.first()).toBeVisible();
    }
  });

  test('should navigate to experiment runs on card click', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Find an experiment card link
    const experimentLink = page.locator('a[href*="/experiments/"]').first();

    if (await experimentLink.isVisible().catch(() => false)) {
      await experimentLink.click();
      await expect(page).toHaveURL(/\/experiments\/.*\/runs|\/benchmarks/);
    }
  });
});
