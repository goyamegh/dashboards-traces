/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

const MOBILE = { width: 390, height: 844 };

test.describe('Mobile responsive shell', () => {
  test.use({ viewport: MOBILE });

  test('opens and dismisses the off-canvas navigation without covering content', async ({ page }) => {
    await page.goto('/evaluations/runs');

    // The off-canvas drawer's fixed positioning + slide transform live on the
    // wrapping "sidebar-hover-zone" element (it also reserves the desktop
    // rail/flyout width — see sidebar-hover-flyout.spec.ts); the inner
    // "sidebar" element is absolutely positioned within it.
    const sidebarZone = page.getByTestId('sidebar-hover-zone');
    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebarZone).toHaveClass(/-translate-x-full/);

    await open.click();
    const close = page.locator('button[aria-label="Close navigation"][aria-expanded="true"]');
    await expect(close).toBeVisible();
    await expect(sidebarZone).toHaveClass(/translate-x-0/);

    // The backdrop is a separate accessible close target for touch users.
    await page.locator('button.fixed.inset-0[aria-label="Close navigation"]').click({ position: { x: 380, y: 400 } });
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(sidebarZone).toHaveClass(/-translate-x-full/);
  });

  test('closes the drawer after mobile navigation and keeps page width bounded', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.getByRole('button', { name: 'Open navigation' }).click();

    await page.getByTestId('nav-evals3-benchmarks').click();
    await expect(page).toHaveURL(/\/evaluations\/benchmarks$/);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  });
});

test('desktop keeps the persistent sidebar and hides the mobile toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/evaluations/runs');

  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  const sidebarZone = page.getByTestId('sidebar-hover-zone');
  await expect(sidebarZone).toHaveClass(/lg:relative/);
  // transform (translate) is fully reset at desktop — an active translate
  // value (even translate-x-0) creates a stacking context that traps the
  // sidebar's z-index above <main>, see components/Layout.tsx.
  await expect(sidebarZone).toHaveClass(/lg:transform-none/);
});
