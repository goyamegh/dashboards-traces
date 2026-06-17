/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression for the Settings → Data Source connectivity badge (#281).
 *
 * The original bug: a green "Connected to OpenSearch" badge showed while the
 * server was actually on the file-storage fallback (OpenSearch configured but
 * unreachable), next to a stale red "Response Error". These tests mock
 * /api/storage/health so the three states render deterministically and assert
 * the badge is truthful — so the bug cannot silently return.
 *
 * /api/storage/health returns the ACTIVE backend at top level; real OpenSearch
 * state is nested under health.opensearch.
 */

import { test, expect } from './fixtures/test-fixtures';

const STATS_OK = {
  stats: {
    evals_test_cases: { count: 3 },
    evals_experiments: { count: 1 },
    evals_runs: { count: 5 },
    evals_analytics: { count: 0 },
  },
};

const CONFIG_STATUS_CONFIGURED = {
  storage: { configured: true, source: 'file', endpoint: 'https://cluster.example.com', authType: 'sigv4', awsRegion: 'us-east-1', awsService: 'es' },
  observability: { configured: false, source: 'none' },
};

/** Mock the storage endpoints the Data Source panel reads, then load /settings. */
async function mockStorageAndOpen(page: any, health: unknown) {
  await page.route('**/api/storage/config/status', (r: any) => r.fulfill({ status: 200, json: CONFIG_STATUS_CONFIGURED }));
  await page.route('**/api/storage/stats', (r: any) => r.fulfill({ status: 200, json: STATS_OK }));
  await page.route('**/api/storage/health', (r: any) => r.fulfill({ status: 200, json: health }));
  await page.goto('/settings');
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  await expect(page.locator('text=Loading storage stats')).not.toBeVisible({ timeout: 30000 }).catch(() => {});
}

test.describe('Settings → Data Source connectivity badge (#281)', () => {
  test.describe.configure({ mode: 'serial' });

  test('shows amber "unreachable" (not false green / stale red) when OpenSearch is configured but down', async ({ page }) => {
    // Active backend fell back to file; real OpenSearch state is error.
    await mockStorageAndOpen(page, {
      status: 'ok',
      backend: 'file',
      opensearch: { status: 'error', message: 'Response Error' },
    });

    await expect(page.locator('text=OpenSearch unreachable — using file storage fallback')).toBeVisible({ timeout: 15000 });
    // The misleading green badge must NOT be shown.
    await expect(page.locator('text=Connected to OpenSearch')).toHaveCount(0);
    // The underlying error is surfaced.
    await expect(page.locator('text=Response Error')).toBeVisible();
  });

  test('shows green "Connected to OpenSearch" only on a real OpenSearch connection', async ({ page }) => {
    await mockStorageAndOpen(page, {
      status: 'ok',
      backend: 'opensearch',
      opensearch: { status: 'ok', latencyMs: 42 },
    });

    await expect(page.locator('text=Connected to OpenSearch')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=OpenSearch unreachable — using file storage fallback')).toHaveCount(0);
  });

  test('does not show green when on file storage with no OpenSearch configured', async ({ page }) => {
    await mockStorageAndOpen(page, { status: 'ok', backend: 'file' });

    await expect(page.locator('text=Connected to OpenSearch')).toHaveCount(0);
  });
});
