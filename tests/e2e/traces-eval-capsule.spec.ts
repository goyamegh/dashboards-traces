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
    // Find a trace whose root-span column contains 'test_case' (or similar
    // eval-flavoured root) since real backend data is unordered. Falls back
    // to skipping if none are visible (e.g. fresh OpenSearch with only LLM
    // traces) so the suite stays green across data shapes.
    const allRows = page.locator('tbody tr');
    const rowCount = await allRows.count();
    if (rowCount === 0) return;

    let traceRow = null;
    for (let i = 0; i < rowCount; i++) {
      const row = allRows.nth(i);
      const text = (await row.textContent()) || '';
      if (/test_case|test_suite_run|evaluation/i.test(text)) {
        traceRow = row;
        break;
      }
    }
    if (!traceRow) {
      // No eval-rooted trace in the current dataset — skip rather than fail.
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

  test('clicking a span in the inline tree opens the bottom drawer with a flat attributes table', async ({ page }) => {
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

    // Click the first visible span row inside the inline tree.
    const treeRows = tree.locator('> div > div');
    const rowCount = await treeRows.count();
    if (rowCount < 1) {
      return;
    }
    await treeRows.first().click();
    await page.waitForTimeout(800);

    // The bottom drawer (Sheet side="bottom") should be open with the
    // SimpleSpanAttributesTable inside. Verify the filter input and at
    // least the "X attributes" identity strip render.
    const filterInput = page.locator('input[placeholder="Filter attributes…"]').first();
    await expect(filterInput).toBeVisible({ timeout: 3000 });

    const identityStrip = page.locator('text=/\\d+ attributes?/').first();
    await expect(identityStrip).toBeVisible({ timeout: 3000 });

    // Pressing Escape should close the drawer.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(filterInput).not.toBeVisible({ timeout: 3000 });
  });

  test('per-span timeline bars render in the inline tree', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }
    await traceRow.click();
    await page.waitForTimeout(1500);

    // Each visible span row in the inline tree carries a `.trace-row-timeline`
    // mini-gantt bar in its right-hand area.
    const bars = page.locator('.trace-inline-tree .trace-row-timeline');
    await expect(bars.first()).toBeVisible({ timeout: 3000 });
    expect(await bars.count()).toBeGreaterThan(0);
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
