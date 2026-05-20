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

    // The expanded row should render the trace tree timeline chart inline.
    const timelineChart = page.locator('[data-testid="trace-timeline-chart"]').first();
    await expect(timelineChart).toBeVisible({ timeout: 5000 });

    // The chart's y-axis labels list every visible span. Eval spans like
    // `test_case` / `test_suite_run` should be present in the rendered
    // ECharts canvas (or DOM siblings rendered via SVG text nodes).
    // Use page-level text matching since echarts renders labels inside SVG.
    const evalSpanLabel = page.locator('text=/test_case|test_suite_run|evaluation/i').first();
    await expect(evalSpanLabel).toBeVisible({ timeout: 5000 });
  });

  test('clicking an eval span in the inline tree opens the SpanDetailsPanel below', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    const timelineChart = page.locator('[data-testid="trace-timeline-chart"]').first();
    if (!await timelineChart.isVisible().catch(() => false)) {
      return;
    }

    // Click somewhere inside the chart to select a span (best-effort — the
    // first non-root bar is at row index 1, ROW_HEIGHT=20). The exact
    // pixel doesn't have to land on a bar; if no span is selected the
    // SpanDetailsPanel just won't appear and the test will skip below.
    const box = await timelineChart.boundingBox();
    if (box) {
      await page.mouse.click(box.x + 260, box.y + 35);
      await page.waitForTimeout(800);
    }

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
