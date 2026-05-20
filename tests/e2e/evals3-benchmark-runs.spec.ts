/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 Benchmark Runs Page', () => {
  let benchmarkId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Create a benchmark with test cases so we have data to navigate to
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: 'E2E BM Runs TC',
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
      },
    });
    let testCaseId: string | null = null;
    if (tcRes.ok()) {
      const tcData = await tcRes.json();
      testCaseId = tcData.id || tcData.testCase?.id;
    }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: 'E2E BM Runs Benchmark',
        description: 'Created for e2e benchmark runs test',
        testCaseIds: testCaseId ? [testCaseId] : [],
      },
    });
    if (bmRes.ok()) {
      const bmData = await bmRes.json();
      benchmarkId = bmData.id || bmData.benchmark?.id;
    }
  });

  test.afterAll(async ({ request }) => {
    // Cleanup
    const bmRes = await request.get('/api/storage/benchmarks').catch(() => null);
    if (bmRes?.ok()) {
      const data = await bmRes.json();
      const benchmarks = Array.isArray(data) ? data : data.benchmarks ?? [];
      for (const bm of benchmarks) {
        if (bm.name?.startsWith('E2E BM Runs')) {
          await request.delete(`/api/storage/benchmarks/${encodeURIComponent(bm.id)}`).catch(() => {});
        }
      }
    }
    const tcRes = await request.get('/api/storage/test-cases').catch(() => null);
    if (tcRes?.ok()) {
      const data = await tcRes.json();
      const tcs = Array.isArray(data) ? data : data.testCases ?? [];
      for (const tc of tcs) {
        if (tc.name?.startsWith('E2E BM Runs')) {
          await request.delete(`/api/storage/test-cases/${encodeURIComponent(tc.id)}`).catch(() => {});
        }
      }
    }
  });

  test('should display benchmark name as heading', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('h2:has-text("E2E BM Runs Benchmark")')).toBeVisible();
  });

  test('should show run count in subtitle', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('text=/\\d+ runs?/')).toBeVisible();
  });

  test('should show Add Run button', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('button:has-text("Add Run")')).toBeVisible();
  });

  test('should show Runs and Test Cases tabs', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('[role="tab"]:has-text("Runs")')).toBeVisible();
    await expect(page.locator('[role="tab"]:has-text("Test Cases")')).toBeVisible();
  });

  test('should show breadcrumbs with navigation', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    // Breadcrumbs: Evaluations > Benchmarks > <name>
    await expect(page.locator('text=Evaluations').first()).toBeVisible();
    await expect(page.locator('a:has-text("Benchmarks")')).toBeVisible();
  });

  test('should open run config when clicking Add Run', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await page.click('button:has-text("Add Run")');
    await page.waitForTimeout(500);

    // Should see agent/model selection or run configuration UI
    const hasRunConfig = await page.locator('text=Agent').or(page.locator('text=Model')).first().isVisible().catch(() => false);
    expect(hasRunConfig).toBeTruthy();
  });

  test('should handle benchmark with undefined testCaseIds', async ({ page, request }) => {
    // Create benchmark without testCaseIds
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: 'E2E BM Runs No TcIds' },
    });
    let id: string | null = null;
    if (res.ok()) {
      const data = await res.json();
      id = data.id || data.benchmark?.id;
    }
    test.skip(!id, 'Failed to create benchmark');

    // Navigate — should NOT crash
    await page.goto(`/evaluations/benchmarks/${id}/runs`);
    await page.waitForTimeout(3000);

    // Page should render without "Cannot read properties of undefined" error
    const hasError = await page.locator('text=Cannot read properties').isVisible().catch(() => false);
    expect(hasError).toBeFalsy();

    // Cleanup
    if (id) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
    }
  });
});
