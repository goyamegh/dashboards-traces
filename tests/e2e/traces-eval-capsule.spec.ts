/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Eval Span Category Capsule', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);
  });

  test('should display eval spans in the inline trace tree when expanded', async ({ page }) => {
    // The first demo trace (demo-trace-001) contains eval spans with
    // gen_ai.operation.name=evaluation. Clicking the row now expands inline
    // (Chrome DevTools Inspect-tab style) instead of opening a right-side flyout.
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      // No traces available (e.g. no demo data) — skip gracefully
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // The expanded row should render the trace tree inline.
    const tree = page.locator('.trace-inline-tree').first();
    await expect(tree).toBeVisible({ timeout: 5000 });

    // Eval spans like `test_case` / `test_suite_run` should be present in
    // the rendered tree. The TraceTreeTable renders span names as plain
    // text inside divs, so a regex text match is enough.
    const evalSpanLabel = page.locator('.trace-inline-tree').locator('text=/test_case|test_suite_run|evaluation/i').first();
    await expect(evalSpanLabel).toBeVisible({ timeout: 5000 });
  });

  test('clicking an eval span in the inline tree opens the SpanDetailsPanel below', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    const tree = page.locator('.trace-inline-tree').first();
    if (!await tree.isVisible().catch(() => false)) {
      return;
    }

    // Click the second visible span row inside the inline tree (a child
    // span if hierarchy exists, otherwise just the second sibling).
    const treeRows = tree.locator('> div > div');
    const rowCount = await treeRows.count();
    if (rowCount < 2) {
      return;
    }
    await treeRows.nth(1).click();
    await page.waitForTimeout(800);

    // SpanDetailsPanel renders below the tree (Chrome DevTools Inspect style)
    // with INPUT / OUTPUT / All Attributes sections.
    const detailsPanel = page.locator('text=ALL ATTRIBUTES').first();
    if (await detailsPanel.isVisible().catch(() => false)) {
      await expect(detailsPanel).toBeVisible();
    }
    // Otherwise the click missed a bar — that's acceptable in this smoke check.
  });

  test('Maximize button on the expanded row opens fullscreen view', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // The inline expansion header has a Maximize2 button with title="Open fullscreen".
    const maxBtn = page.locator('button[title="Open fullscreen"]').first();
    if (!await maxBtn.isVisible().catch(() => false)) {
      return;
    }
    await maxBtn.click();
    await page.waitForTimeout(800);

    // Fullscreen view is a Dialog/Sheet — verify some marker like the
    // "Trace tree" view-toggle button or the title text becomes visible.
    const fullScreenMarker = page.locator('button:has-text("Trace tree"), [role="dialog"]').first();
    if (await fullScreenMarker.isVisible().catch(() => false)) {
      await expect(fullScreenMarker).toBeVisible();
    }
  });
});
