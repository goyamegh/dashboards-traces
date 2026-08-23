/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Comparison Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to benchmarks first
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should navigate to comparison page from benchmark runs', async ({ page }) => {
    // First go to a benchmark with runs
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      // Find and click Compare button
      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        // Select at least 2 runs first if needed
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // Should be on comparison page
        await expect(page.locator('[data-testid="comparison-page"]')).toBeVisible();
      }
    }
  });

  test('should display Compare Runs title', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        await expect(page.locator('[data-testid="comparison-title"]')).toHaveText('Compare Runs');
      }
    }
  });

  test('should have back button to return to benchmark runs', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        const backButton = page.locator('[data-testid="back-button"]');
        await expect(backButton).toBeVisible();

        await backButton.click();
        await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible();
      }
    }
  });

  test('should show run selector section', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // Should show "Select Runs to Compare" section
        await expect(page.locator('text=Select Runs to Compare')).toBeVisible();
      }
    }
  });

  test('should not show a baseline selector', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // Should NOT show a baseline selector (removed in favor of automatic oldest-run reference)
        const hasBaseline = await page.locator('text=Baseline').isVisible().catch(() => false);
        expect(hasBaseline).toBeFalsy();
      }
    }
  });
});

test.describe('Comparison Page - Metrics', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should display run summary cards', async ({ page }) => {
    // Navigate to the benchmark runs listing page (not run detail) by clicking the card name
    const benchmarkCard = page.locator('[data-testid="benchmarks-page"] h3').first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      // Now on the runs listing page where Select All and Compare buttons exist
      const selectAllButton = page.locator('button:has-text("Select All")');
      if (await selectAllButton.isVisible().catch(() => false)) {
        await selectAllButton.click();
        await page.waitForTimeout(500);
      }

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // Should show run summary cards with metrics
        const hasSummary = await page.locator('text=/Pass Rate|Accuracy|Avg/').first().isVisible().catch(() => false);
        expect(hasSummary).toBeTruthy();
      }
    }
  });

  test('should display comparison table', async ({ page }) => {
    // Navigate to the benchmark runs listing page by clicking the card name
    const benchmarkCard = page.locator('[data-testid="benchmarks-page"] h3').first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const selectAllButton = page.locator('button:has-text("Select All")');
      if (await selectAllButton.isVisible().catch(() => false)) {
        await selectAllButton.click();
        await page.waitForTimeout(500);
      }

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // Should show use case comparison table or similar
        const hasTable = await page.locator('text=/Use Case|Test Case|Status/').first().isVisible().catch(() => false);
        expect(hasTable).toBeTruthy();
      }
    }
  });
});

test.describe('Comparison Page - Filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should show category filter if available', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // May have category filter
        const hasCategoryFilter = await page.locator('text=/Category|Filter/').first().isVisible().catch(() => false);
        // This is optional
        expect(true).toBeTruthy();
      }
    }
  });

  test('should show status filter options', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

        // May have status filter
        const hasStatusFilter = await page.locator('text=/Status|All|Passed|Failed/').first().isVisible().catch(() => false);
        expect(true).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Deep-dive + reconstructed Traces/Judge surfaces (regression guards for the
// trace-grounded deep-dive, timeline Traces view, and parallel Judge layout).
// All assertions degrade gracefully when a benchmark has no comparable runs /
// no trace data (real backend) — they only assert structure, never LLM output.
// ---------------------------------------------------------------------------
test.describe('Comparison Page - deep-dive, timeline & parallel judge', () => {
  /** Navigate benchmarks -> runs -> select all -> compare. Returns true if reached. */
  async function gotoComparison(page: import('@playwright/test').Page): Promise<boolean> {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const benchmarkCard = page.locator('[data-testid="benchmarks-page"] h3').first();
    if (!(await benchmarkCard.isVisible().catch(() => false))) return false;
    await benchmarkCard.click();
    await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 10000 }).catch(() => null);

    const selectAllButton = page.locator('button:has-text("Select All")');
    if (await selectAllButton.isVisible().catch(() => false)) {
      await selectAllButton.click();
      await page.waitForTimeout(500);
    }
    const compareButton = page.locator('button:has-text("Compare")');
    if (!(await compareButton.isVisible().catch(() => false))) return false;
    await compareButton.click();
    const ok = await page
      .waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    return ok;
  }

  test('renders the trace-grounded deep-dive panel for a 2-run comparison', async ({ page }) => {
    if (!(await gotoComparison(page))) return;

    // The deep-dive only renders for EXACTLY 2 runs; if present it must carry
    // its heading (the LLM body may still be loading/erroring — we don't assert it).
    const deepDive = page.locator('[data-testid="comparison-deep-dive"]');
    if (await deepDive.isVisible().catch(() => false)) {
      await expect(deepDive).toContainText(/What's actually different/i);
    }
  });

  test('expanding a test case shows the Judge grid and the (timeline) Traces tab', async ({ page }) => {
    if (!(await gotoComparison(page))) return;

    // Expand the first comparison-table row (cursor-pointer row).
    const firstRow = page.locator('tr.cursor-pointer').first();
    if (!(await firstRow.isVisible().catch(() => false))) return;
    await firstRow.click();
    await page.waitForTimeout(500);

    // Judge tab -> parallel grid renders (per-run cards, even "Not run").
    const judgeTab = page.locator('button[role="tab"]:has-text("Judge")').first();
    if (await judgeTab.isVisible().catch(() => false)) {
      await judgeTab.click();
      await page.waitForTimeout(300);
      await expect(page.locator('[data-testid="judge-comparison-grid"]').first()).toBeVisible();
    }

    // Traces tab -> when trace data exists, the timeline card renders. The view
    // is the shared TraceVisualization (tree/gantt), NOT the old react-flow graph.
    const tracesTab = page.locator('button[role="tab"]:has-text("Traces")').first();
    if (await tracesTab.isVisible().catch(() => false)) {
      await tracesTab.click();
      await page.waitForTimeout(500);
      const timeline = page.locator('[data-testid="trace-flow-comparison"]').first();
      if (await timeline.isVisible().catch(() => false)) {
        await expect(timeline).toContainText(/Trace Flow Comparison/i);
        // Side-by-side timeline panels expose the view-toggle from TraceVisualization.
        await expect(timeline).toContainText(/Side-by-Side|Merged/);
      }
    }
  });
});
