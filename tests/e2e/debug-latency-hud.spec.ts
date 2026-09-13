/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the debug/dev-mode page-latency HUD (DebugLatencyHud + lib/pageLatency.ts).
 *
 * Regression guard for the owner ask: "publish latencies of each page when
 * debugging or dev mode is enabled." Drives the SAME mechanism the Settings
 * page uses to enable debug mode client-side -- `localStorage.agenteval_debug`
 * (see lib/debug.ts's isDebugEnabled()) -- via `page.addInitScript` so it's
 * set before the app's first script runs, then navigates between pages and
 * checks the HUD renders a non-zero-ms record for the route. With debug left
 * off, the HUD must never appear (zero behaviour change).
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Debug latency HUD', () => {
  test('is absent when debug mode is off', async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });

  test('shows the current route + timing once debug mode is enabled, and updates across navigations', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const hud = page.getByTestId('debug-latency-hud');
    await expect(hud).toBeVisible({ timeout: 15_000 });
    await expect(hud).toContainText('benchmarks', { timeout: 15_000 });
    // Render time is measured within ~2 animation frames of navigation —
    // give it a moment, then require a real (non-em-dash) ms value.
    await expect(hud).not.toContainText('render —', { timeout: 15_000 });

    // Client-side nav (NOT page.goto -- a full reload would reset the
    // module-level history this test is about to check for).
    await page.getByTestId('nav-evals3-runs').click();
    await expect(hud).toContainText('eval-runs', { timeout: 15_000 });

    // Hovering reveals history with at least the previous navigation in it.
    await hud.hover();
    const history = page.getByTestId('debug-latency-hud-history');
    await expect(history).toBeVisible();
    await expect(history).toContainText('benchmarks');
  });

  test('disappears again once debug mode is turned back off (next navigation)', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });
    await page.goto('/evaluations/benchmarks');
    await expect(page.getByTestId('debug-latency-hud')).toBeVisible({ timeout: 15_000 });

    await page.evaluate(() => window.localStorage.setItem('agenteval_debug', 'false'));
    await page.getByTestId('nav-evals3-runs').click();
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });
});
