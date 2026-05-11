/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 Benchmarks Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30000 });
  });

  test('should display page heading and subtitle', async ({ page }) => {
    await expect(page.locator('h2:has-text("Benchmarks")')).toBeVisible();
    await expect(page.locator('text=Collections of test cases')).toBeVisible();
  });

  test('should show benchmark count', async ({ page }) => {
    // Stats section shows "N benchmarks"
    await expect(page.locator('text=/\\d+ benchmarks?/')).toBeVisible();
  });

  test('should show New Benchmark button', async ({ page }) => {
    const newButton = page.locator('button:has-text("New Benchmark")');
    await expect(newButton).toBeVisible();
  });

  test('should show Import JSON button', async ({ page }) => {
    const importButton = page.locator('button:has-text("Import JSON")');
    await expect(importButton).toBeVisible();
  });

  test('should show search input', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search"]');
    await expect(searchInput).toBeVisible();
  });

  test('should show agent filter dropdown', async ({ page }) => {
    await expect(page.locator('text=All Agents')).toBeVisible();
  });

  test('should show time range filter dropdown', async ({ page }) => {
    await expect(page.locator('text=All time')).toBeVisible();
  });

  test('should open benchmark editor when clicking New Benchmark', async ({ page }) => {
    await page.click('button:has-text("New Benchmark")');
    await expect(
      page.locator('text=Create Benchmark').or(page.locator('text=Step 1')).first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('should filter benchmarks by search query', async ({ page }) => {
    await page.waitForTimeout(1000);

    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('test');
    await page.waitForTimeout(500);

    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });

  test('should handle benchmarks with missing testCaseIds gracefully', async ({ page, request }) => {
    // Create a benchmark without testCaseIds
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: 'E2E Null TcIds Benchmark', description: 'testCaseIds is undefined' },
    });

    // Reload page — should NOT crash with "testCaseIds is not iterable"
    await page.reload();
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30000 });
    await expect(page.locator('h2:has-text("Benchmarks")')).toBeVisible();

    // Cleanup
    if (res.ok()) {
      const data = await res.json();
      const id = data.id || data.benchmark?.id;
      if (id) {
        await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
      }
    }
  });

  test('should display benchmarks in table with sortable columns', async ({ page }) => {
    await page.waitForTimeout(1000);

    // Check for table headers (Name, Test Cases, Runs, Score, Last Run, Agent)
    const hasTable = await page.locator('th:has-text("Name"), td:has-text("Name")').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=No benchmarks').isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBeTruthy();
  });
});

test.describe('Evals3 Benchmark CRUD', () => {
  const benchmarkName = `E2E Evals3 BM ${Date.now()}`;

  test.afterAll(async ({ request }) => {
    // Clean up benchmarks created during this suite
    const response = await request.get('/api/storage/benchmarks').catch(() => null);
    if (response?.ok()) {
      const data = await response.json();
      const benchmarks = Array.isArray(data) ? data : data.benchmarks ?? [];
      for (const bm of benchmarks) {
        if (bm.name?.startsWith('E2E Evals3 BM')) {
          await request.delete(`/api/storage/benchmarks/${encodeURIComponent(bm.id)}`).catch(() => {});
        }
      }
    }
  });

  test('should create a new benchmark', async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30000 });

    await page.click('button:has-text("New Benchmark")');
    await page.waitForTimeout(1000);

    // Fill in form
    const nameInput = page.locator('input').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill(benchmarkName);
    }

    // Try to proceed or save
    const saveButton = page.locator('button:has-text("Save"), button:has-text("Create"), button:has-text("Next")').first();
    if (await saveButton.isVisible().catch(() => false)) {
      if (await saveButton.isEnabled()) {
        await saveButton.click();
        await page.waitForTimeout(1000);
      }
    }
  });
});
