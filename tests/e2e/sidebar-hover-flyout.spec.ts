/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Chrome-vertical-tabs-style sidebar hover-open.
 *
 * When the sidebar is pinned collapsed (icon rail), hovering — or
 * keyboard-focusing — the rail must temporarily expand the FULL sidebar as an
 * OVERLAY: the content area keeps reserving the rail width (no reflow), and
 * leaving/blurring it collapses the sidebar again. The expand button inside
 * the expanded sidebar acts as "pin open" and persists.
 */

// Import the local fixtures (not the raw '@playwright/test' module) so this
// spec's page interactions are captured by the E2E Istanbul coverage
// collector (see tests/e2e/fixtures/test-fixtures.ts) — this spec exercises
// most of Layout.tsx's hover-open logic.
import { test, expect } from './fixtures/test-fixtures';

test.describe('Sidebar hover-open', () => {
  test('collapsed rail expands to the full sidebar on hover as an overlay and collapses on leave', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(zone).toBeVisible();

    // Pin collapsed via the collapse button.
    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar).toHaveCSS('width', '64px');

    // Hover the rail → the FULL sidebar expands (after the 150ms intent
    // delay) while the layout zone keeps the rail width — content never
    // moves. Every nav group (not just one item) is visible in the expansion.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar.getByText('Overview', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Evaluations', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Settings', { exact: true })).toBeVisible();

    // Leave the sidebar → collapses back to the rail (250ms grace).
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '64px');

    // The pin preference persisted: still a rail after reload.
    await page.reload();
    await expect(zone).toHaveCSS('width', '64px');
  });

  test('keyboard focus inside the rail also opens the full sidebar (a11y — not mouse-only)', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');

    // Focusing a link inside the collapsed rail opens the full sidebar
    // immediately (no hover-intent delay needed for keyboard users).
    const overviewLink = page.locator('[data-testid="nav-overview"]');
    await overviewLink.focus();
    await expect(sidebar).toHaveCSS('width', '180px');

    // Tabbing to the next focusable item inside the (now expanded) sidebar
    // keeps it open — focus never leaves the hover zone.
    await page.keyboard.press('Tab');
    await expect(sidebar).toHaveCSS('width', '180px');

    // Moving focus away entirely collapses it back to the rail.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(sidebar).toHaveCSS('width', '64px');
  });

  test('expand button inside the hover-open sidebar pins it open', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');

    // Fly out, then pin open.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await page.getByLabel('Expand sidebar').click();

    // Pinned: the LAYOUT zone widens too (content reflows), and mousing away
    // no longer collapses it.
    await expect(zone).toHaveCSS('width', '180px');
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '180px');

    // Persisted across reload.
    await page.reload();
    await expect(zone).toHaveCSS('width', '180px');
  });

  test('the collapsed Evaluations icon and the expanded Evaluations link share the nav-evals3 testid', async ({ page }) => {
    // Regression guard for the flyout mid-click retarget: both the rail's
    // icon-only Evaluations button and the hover-opened group-header link
    // must carry the same testid so a click that starts on the rail lands on
    // the expanded target if the flyout swaps in mid-click.
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    const collapsedEvals = sidebar.locator('a[data-testid="nav-evals3"]');
    await expect(collapsedEvals).toBeVisible();
    await expect(collapsedEvals).toHaveAttribute('href', /\/evaluations\/runs$/);

    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    const expandedEvals = sidebar.locator('a[data-testid="nav-evals3"]');
    await expect(expandedEvals).toBeVisible();
    await expect(expandedEvals).toHaveAttribute('href', /\/evaluations\/runs$/);
  });
});
