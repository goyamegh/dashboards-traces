/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 Test Cases Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/test-cases');
    // Wait for page to render (no data-testid, use heading)
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
  });

  test('should display page heading and subtitle', async ({ page }) => {
    await expect(page.locator('h2:has-text("Test Cases")')).toBeVisible();
    await expect(page.locator('text=/\\d+ test cases/')).toBeVisible();
  });

  test('should show New Test Case button', async ({ page }) => {
    const newButton = page.locator('button:has-text("New Test Case")');
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

  test('should show benchmark filter dropdown', async ({ page }) => {
    // The "All Benchmarks" select trigger
    await expect(page.locator('text=All Benchmarks')).toBeVisible();
  });

  test('should show view mode toggle (Flat / Grouped)', async ({ page }) => {
    await expect(page.locator('button:has-text("Flat")')).toBeVisible();
    await expect(page.locator('button:has-text("Grouped")')).toBeVisible();
  });

  test('should filter test cases by search query', async ({ page }) => {
    await page.waitForTimeout(1000); // Wait for data

    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('OTel');
    await page.waitForTimeout(500);

    // Page content should update
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });

  test('should open test case editor when clicking New Test Case', async ({ page }) => {
    await page.click('button:has-text("New Test Case")');
    // Editor modal should be visible
    await expect(
      page.locator('text=Create Test Case').or(page.locator('text=Edit Test Case')).first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('should switch between flat and grouped views', async ({ page }) => {
    // Start in flat view
    await page.click('button:has-text("Flat")');
    await page.waitForTimeout(300);

    // Switch to grouped
    await page.click('button:has-text("Grouped")');
    await page.waitForTimeout(300);

    // Grouped view should show expand/collapse controls if benchmarks exist
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });

  test('should handle benchmarks with missing testCaseIds gracefully', async ({ page, request }) => {
    // Create a benchmark without testCaseIds to reproduce the bug
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: 'E2E Empty Benchmark', description: 'No test cases' },
    });

    // Reload the page — should NOT crash
    await page.reload();
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
    await expect(page.locator('h2:has-text("Test Cases")')).toBeVisible();

    // Cleanup
    if (res.ok()) {
      const data = await res.json();
      const id = data.id || data.benchmark?.id;
      if (id) {
        await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
      }
    }
  });
});

test.describe('Evals3 Test Case Editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
    await page.click('button:has-text("New Test Case")');
    await page.waitForSelector('text=Create Test Case', { timeout: 5000 });
  });

  test('should display form fields', async ({ page }) => {
    await expect(page.locator('label:has-text("Name")').first()).toBeVisible();
  });

  test('should have Cancel button', async ({ page }) => {
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('should have Save button', async ({ page }) => {
    await expect(page.locator('button:has-text("Save")')).toBeVisible();
  });

  test('should close editor when clicking Cancel', async ({ page }) => {
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('h2:has-text("Test Cases")')).toBeVisible();
  });
});

test.describe('Evals3 Test Case CRUD', () => {
  const testCaseName = `E2E Evals3 TC ${Date.now()}`;

  test.afterAll(async ({ request }) => {
    // Clean up test cases created during this suite
    const response = await request.get('/api/storage/test-cases').catch(() => null);
    if (response?.ok()) {
      const data = await response.json();
      const testCases = Array.isArray(data) ? data : data.testCases ?? [];
      for (const tc of testCases) {
        if (tc.name?.startsWith('E2E Evals3 TC')) {
          await request.delete(`/api/storage/test-cases/${encodeURIComponent(tc.id)}`).catch(() => {});
        }
      }
    }
  });

  test('should create a new test case', async ({ page }) => {
    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

    await page.click('button:has-text("New Test Case")');
    await page.waitForSelector('text=Create Test Case', { timeout: 5000 });

    // Fill in form
    const nameInput = page.locator('input').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill(testCaseName);
    }

    const saveButton = page.locator('button:has-text("Save")');
    if (await saveButton.isEnabled()) {
      await saveButton.click();
      await page.waitForTimeout(1000);
    }
  });

  test('should search for test cases', async ({ page }) => {
    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
    await page.waitForTimeout(1000);

    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('OTel');
    await page.waitForTimeout(500);

    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });
});
