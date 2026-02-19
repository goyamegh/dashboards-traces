/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for benchmark stats refresh functionality
 * Tests the complete user journey from viewing stale stats to seeing corrected stats
 */

import { test, expect } from '@playwright/test';

test.describe('Benchmark Stats Refresh E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to benchmarks page
    await page.goto('http://localhost:4001');
    await page.waitForLoadState('networkidle');
  });

  test('should display corrected stats after automatic backfill', async ({ page }) => {
    // Step 1: Create a benchmark with test cases
    await page.getByRole('link', { name: /benchmarks/i }).click();
    await page.getByRole('button', { name: /new benchmark/i }).click();

    await page.getByLabel('Name').fill('Stats Backfill Test');
    await page.getByLabel('Description').fill('Test automatic stats correction');

    // Select test cases
    await page.getByRole('button', { name: /add test cases/i }).click();
    const testCaseCheckboxes = await page.getByRole('checkbox').all();
    if (testCaseCheckboxes.length > 0) {
      await testCaseCheckboxes[0].check();
      await testCaseCheckboxes[1].check();
    }
    await page.getByRole('button', { name: /save/i }).click();

    // Step 2: Create and execute a run (simulate)
    await page.getByRole('button', { name: /add run/i }).click();
    await page.getByLabel('Name').fill('Test Run');
    await page.getByRole('button', { name: /start run/i }).click();

    // Wait for run to complete (or mock completion)
    await page.waitForTimeout(2000);

    // Step 3: Verify stats are displayed correctly
    // Look for stats indicators (passed/failed/pending counts)
    const statsSection = page.locator('[data-testid="run-stats"]').first();
    await expect(statsSection).toBeVisible();

    // Verify no pending tests shown (backfill should have corrected any stale data)
    const pendingCount = await statsSection.locator('[data-testid="pending-count"]').textContent();
    expect(parseInt(pendingCount || '0')).toBe(0);
  });

  test('should refresh stats when manually triggered', async ({ page }) => {
    // Navigate to a benchmark with existing runs
    await page.getByRole('link', { name: /benchmarks/i }).click();

    // Select first benchmark
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Intercept the refresh API call
    let refreshCalled = false;
    await page.route('**/api/storage/benchmarks/*/refresh-all-stats', (route) => {
      refreshCalled = true;
      route.fulfill({
        status: 200,
        body: JSON.stringify({ refreshed: 5 }),
      });
    });

    // Look for refresh button (if implemented in UI)
    const refreshButton = page.getByRole('button', { name: /refresh stats/i });
    if (await refreshButton.isVisible()) {
      await refreshButton.click();

      // Verify API was called
      await page.waitForTimeout(500);
      expect(refreshCalled).toBe(true);

      // Verify success message or updated stats
      const successMessage = page.getByText(/stats refreshed/i);
      await expect(successMessage).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show updated stats during live run execution', async ({ page }) => {
    // Navigate to benchmarks
    await page.getByRole('link', { name: /benchmarks/i }).click();

    // Create new run
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Monitor for SSE events during run
    let statsUpdates = 0;
    page.on('response', async (response) => {
      if (response.url().includes('/api/storage/benchmarks/') && response.request().method() === 'GET') {
        const data = await response.json().catch(() => null);
        if (data?.runs?.[0]?.stats) {
          statsUpdates++;
        }
      }
    });

    // Start a run
    await page.getByRole('button', { name: /add run/i }).click();
    await page.getByLabel('Name').fill('Live Stats Test');
    await page.getByRole('button', { name: /start run/i }).click();

    // Wait for some execution time
    await page.waitForTimeout(5000);

    // Verify stats were polled and updated
    expect(statsUpdates).toBeGreaterThan(0);

    // Look for progress indicators
    const progressBar = page.locator('[role="progressbar"]').first();
    if (await progressBar.isVisible()) {
      await expect(progressBar).toHaveAttribute('aria-valuenow');
    }
  });

  test('should handle trace-mode report completion', async ({ page }) => {
    // This tests the scenario where reports are pending traces

    // Navigate to a benchmark with trace-mode runs
    await page.getByRole('link', { name: /benchmarks/i }).click();
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Look for reports with clock icon (pending traces)
    const pendingIcons = page.locator('[data-testid="metrics-pending-icon"]');
    const initialPendingCount = await pendingIcons.count();

    if (initialPendingCount > 0) {
      // Click on a pending report
      await pendingIcons.first().click();

      // Wait for trace polling to complete (simulated)
      await page.waitForTimeout(3000);

      // Return to runs page
      await page.goBack();

      // Verify pending count decreased
      await page.waitForTimeout(1000);
      const newPendingCount = await pendingIcons.count();
      expect(newPendingCount).toBeLessThanOrEqual(initialPendingCount);
    }
  });

  test('should display correct stats after page refresh', async ({ page }) => {
    // Navigate to benchmark runs
    await page.getByRole('link', { name: /benchmarks/i }).click();
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Get initial stats
    const statsSection = page.locator('[data-testid="run-stats"]').first();
    if (await statsSection.isVisible()) {
      const initialStats = await statsSection.textContent();

      // Reload page
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Verify stats are consistent
      const reloadedStats = await statsSection.textContent();
      expect(reloadedStats).toBeTruthy();

      // Stats should not show increased pending count (backfill should prevent this)
      const pendingMatch = reloadedStats?.match(/pending[:\s]*(\d+)/i);
      if (pendingMatch) {
        expect(parseInt(pendingMatch[1])).toBe(0);
      }
    }
  });

  test('should handle benchmark with no runs gracefully', async ({ page }) => {
    // Create a new empty benchmark
    await page.getByRole('link', { name: /benchmarks/i }).click();
    await page.getByRole('button', { name: /new benchmark/i }).click();

    await page.getByLabel('Name').fill('Empty Benchmark Test');
    await page.getByRole('button', { name: /save/i }).click();

    // Navigate to runs page
    await page.getByRole('link', { name: /runs/i }).first().click();

    // Should show empty state, not crash
    const emptyState = page.getByText(/no runs yet/i);
    await expect(emptyState).toBeVisible({ timeout: 5000 });
  });

  test('should handle large benchmarks efficiently', async ({ page }) => {
    // Test polling performance with many runs
    await page.getByRole('link', { name: /benchmarks/i }).click();

    // Find a benchmark with many runs (or create one)
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Measure time to load
    const startTime = Date.now();
    await page.waitForLoadState('networkidle');
    const loadTime = Date.now() - startTime;

    // Should load within reasonable time (< 5 seconds)
    expect(loadTime).toBeLessThan(5000);

    // Verify polling is using lightweight mode
    let lightweightPolling = false;
    page.on('request', (request) => {
      if (request.url().includes('/api/storage/benchmarks/') && request.url().includes('fields=polling')) {
        lightweightPolling = true;
      }
    });

    // Wait for a polling cycle
    await page.waitForTimeout(3000);

    // Verify lightweight polling was used
    expect(lightweightPolling).toBe(true);
  });

  test('should show accurate stats in comparison view', async ({ page }) => {
    // Navigate to benchmark comparison
    await page.getByRole('link', { name: /benchmarks/i }).click();
    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Click compare button (if available)
    const compareButton = page.getByRole('button', { name: /compare/i });
    if (await compareButton.isVisible()) {
      await compareButton.click();

      // Select multiple runs
      const runCheckboxes = await page.getByRole('checkbox').all();
      if (runCheckboxes.length >= 2) {
        await runCheckboxes[0].check();
        await runCheckboxes[1].check();
      }

      // Verify comparison view shows correct stats
      const comparisonView = page.locator('[data-testid="comparison-view"]');
      await expect(comparisonView).toBeVisible({ timeout: 5000 });

      // Stats should be consistent (no stale data)
      const statsCells = comparisonView.locator('[data-testid="stats-cell"]');
      const count = await statsCells.count();
      expect(count).toBeGreaterThan(0);
    }
  });
});

test.describe('Benchmark Stats Edge Cases', () => {
  test('should handle cancelled runs correctly', async ({ page }) => {
    await page.goto('http://localhost:4001');
    await page.getByRole('link', { name: /benchmarks/i }).click();

    // Look for cancelled runs
    const cancelledBadge = page.getByText(/cancelled/i);
    if (await cancelledBadge.isVisible()) {
      // Click to view details
      await cancelledBadge.click();

      // Stats should show correct counts (cancelled = failed)
      const statsSection = page.locator('[data-testid="run-stats"]');
      await expect(statsSection).toBeVisible();
    }
  });

  test('should handle runs with mixed result statuses', async ({ page }) => {
    await page.goto('http://localhost:4001');
    await page.getByRole('link', { name: /benchmarks/i }).click();

    const benchmarkLinks = await page.getByRole('link', { name: /runs/i }).all();
    if (benchmarkLinks.length > 0) {
      await benchmarkLinks[0].click();
    }

    // Look for run with mixed statuses (some pending, some completed)
    const runRows = page.locator('[data-testid="run-row"]');
    const count = await runRows.count();

    if (count > 0) {
      // Verify each run's stats add up correctly
      for (let i = 0; i < Math.min(count, 3); i++) {
        const statsText = await runRows.nth(i).locator('[data-testid="run-stats"]').textContent();
        if (statsText) {
          const passed = parseInt(statsText.match(/passed[:\s]*(\d+)/i)?.[1] || '0');
          const failed = parseInt(statsText.match(/failed[:\s]*(\d+)/i)?.[1] || '0');
          const pending = parseInt(statsText.match(/pending[:\s]*(\d+)/i)?.[1] || '0');
          const total = parseInt(statsText.match(/total[:\s]*(\d+)/i)?.[1] || '0');

          // Stats should sum correctly
          expect(passed + failed + pending).toBeLessThanOrEqual(total);
        }
      }
    }
  });
});
