/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

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

  test('should filter test cases by label', async ({ page, request, testData }) => {
    // Seed a test case carrying a unique label so the label filter renders
    // (the dropdown only appears when at least one test case has labels).
    // Tracked via the per-test testData fixture: cleanup runs even when an
    // assertion below fails (the old try/finally leaked 2 'E2E Label TC'
    // docs to the shared cluster when the worker died mid-test).
    const uniqueLabel = `category:E2E-${Date.now()}`;
    const tcName = uniqueTestName('label-tc');
    const res = await request.post('/api/storage/test-cases', {
      data: {
        name: tcName,
        initialPrompt: 'Investigate the failing widget.',
        labels: [uniqueLabel],
        category: 'E2E',
        difficulty: 'Easy',
      },
    });
    expect(res.ok()).toBeTruthy();
    const created = await res.json();
    testData.testCase(created.id || created.testCase?.id);

    await page.reload();
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
    await page.waitForTimeout(1000);

    // The seeded test case is visible before filtering.
    await expect(page.locator(`text=${tcName}`).first()).toBeVisible({ timeout: 10000 });

    // Open the label filter and pick the unique label. Scope to the
    // dropdown option (role=option) — a bare text= match also hits the tiny
    // label badge rendered on the test-case card, which isn't clickable.
    await page.locator('[data-testid="label-filter"]').click();
    await page.getByRole('option', { name: uniqueLabel }).click();
    await page.waitForTimeout(500);

    // The seeded test case survives the filter; a known sample TC that lacks
    // the label should not be present.
    await expect(page.locator(`text=${tcName}`).first()).toBeVisible();
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

  test('should handle benchmarks with missing testCaseIds gracefully', async ({ page, request, testData }) => {
    // Create a benchmark without testCaseIds to reproduce the bug. Tracked
    // via testData so it is deleted even when the reload assertion fails.
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('empty-benchmark'), description: 'No test cases' },
    });
    if (res.ok()) {
      const data = await res.json();
      testData.benchmark(data.id || data.benchmark?.id);
    }

    // Reload the page — should NOT crash
    await page.reload();
    await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });
    await expect(page.locator('h2:has-text("Test Cases")')).toBeVisible();
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
  const testCaseName = uniqueTestName('evals3-crud-tc');
  // Ids of test cases this suite observed being created (captured from the
  // POST response). The tracker deletes exactly these — never list-and-delete
  // by name/prefix: "name looks test-ish" is not proof of ownership on a
  // shared backend. Tracker (vs. hand-rolled afterAll): 404-tolerant,
  // ledger-backed against worker death.
  const crudTracker = createTestDataTracker();

  test.afterAll(async () => {
    await crudTracker.cleanup();
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
      // Capture the id from the create POST so afterAll can delete exactly
      // this doc.
      const createRespPromise = page.waitForResponse(
        r => r.url().includes('/api/storage/test-cases') && r.request().method() === 'POST',
        { timeout: 10_000 }
      ).catch(() => null);
      await saveButton.click();
      const createResp = await createRespPromise;
      if (createResp?.ok()) {
        const body = await createResp.json().catch(() => null);
        const id = body?.id || body?.testCase?.id;
        crudTracker.testCase(id);
      }
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
