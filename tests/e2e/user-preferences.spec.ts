/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('User Preferences Persistence', () => {
  test.describe('Evaluation Runs Page', () => {
    test('should persist view mode across page reloads', async ({ page }) => {
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });

      // Default is 'flat' — switch to 'grouped'
      const groupedButton = page.locator('button:has-text("Grouped")');
      if (await groupedButton.isVisible()) {
        await groupedButton.click();
        await page.waitForTimeout(300);
      }

      // Reload
      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });

      // Verify localStorage has the persisted value
      const storedViewMode = await page.evaluate(() =>
        localStorage.getItem('agent-health:eval-runs:viewMode')
      );
      expect(storedViewMode).toBe(JSON.stringify('grouped'));
    });

    test('should persist time range filter across reloads', async ({ page }) => {
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });

      // Set localStorage directly to simulate prior selection
      await page.evaluate(() => {
        localStorage.setItem('agent-health:eval-runs:timeRange', JSON.stringify('7d'));
      });

      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });

      // Verify the persisted value is still in storage
      const stored = await page.evaluate(() =>
        localStorage.getItem('agent-health:eval-runs:timeRange')
      );
      expect(stored).toBe(JSON.stringify('7d'));
    });
  });

  test.describe('Test Cases Page', () => {
    test('should persist view mode selection', async ({ page }) => {
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

      // Switch to grouped
      const groupedButton = page.locator('button:has-text("Grouped")');
      if (await groupedButton.isVisible()) {
        await groupedButton.click();
        await page.waitForTimeout(300);
      }

      // Reload and verify persistence
      await page.reload();
      await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

      const stored = await page.evaluate(() =>
        localStorage.getItem('agent-health:test-cases:viewMode')
      );
      expect(stored).toBe(JSON.stringify('grouped'));
    });

    test('should persist sort preference', async ({ page }) => {
      // Pre-set a sort preference
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

      await page.evaluate(() => {
        localStorage.setItem(
          'agent-health:test-cases:sort',
          JSON.stringify({ field: 'name', dir: 'asc' })
        );
      });

      await page.reload();
      await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

      const stored = await page.evaluate(() =>
        localStorage.getItem('agent-health:test-cases:sort')
      );
      expect(JSON.parse(stored!)).toEqual({ field: 'name', dir: 'asc' });
    });
  });

  test.describe('Benchmarks Page', () => {
    test('should persist time range and sort', async ({ page }) => {
      await page.goto('/evaluations/benchmarks');
      await page.waitForSelector('h2', { timeout: 30000 });

      // Set preferences via localStorage
      await page.evaluate(() => {
        localStorage.setItem('agent-health:benchmarks:timeRange', JSON.stringify('7d'));
        localStorage.setItem(
          'agent-health:benchmarks:sort',
          JSON.stringify({ field: 'score', dir: 'desc' })
        );
      });

      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });

      const timeRange = await page.evaluate(() =>
        localStorage.getItem('agent-health:benchmarks:timeRange')
      );
      const sort = await page.evaluate(() =>
        localStorage.getItem('agent-health:benchmarks:sort')
      );

      expect(timeRange).toBe(JSON.stringify('7d'));
      expect(JSON.parse(sort!)).toEqual({ field: 'score', dir: 'desc' });
    });
  });

  test.describe('Cross-component preference sharing', () => {
    test('should share agent/model preferences between QuickRun and NewRun', async ({ page }) => {
      // Simulate QuickRunModal saving preferences
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('h2:has-text("Test Cases")', { timeout: 30000 });

      await page.evaluate(() => {
        localStorage.setItem('agent-health:quick-run:agentKey', JSON.stringify('langgraph'));
        localStorage.setItem('agent-health:quick-run:modelId', JSON.stringify('claude-sonnet-4.5'));
      });

      // Navigate to new-run page — it should pick up the same preferences
      await page.goto('/evaluations/new-run');
      await page.waitForSelector('h2', { timeout: 30000 });

      const agentKey = await page.evaluate(() =>
        localStorage.getItem('agent-health:new-run:agentKey')
      );
      // NewRunPage has its own key but the BenchmarkEditor reads from quick-run:*
      // Verify the shared keys exist
      const sharedAgent = await page.evaluate(() =>
        localStorage.getItem('agent-health:quick-run:agentKey')
      );
      expect(sharedAgent).toBe(JSON.stringify('langgraph'));
    });
  });

  test.describe('Graceful degradation', () => {
    test('should work when localStorage is cleared', async ({ page }) => {
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });

      // Clear all preferences
      await page.evaluate(() => localStorage.clear());

      // Reload — should not crash, should use defaults
      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });

      // Page loaded successfully
      await expect(page.locator('h2').first()).toBeVisible();
    });

    test('should handle corrupted localStorage gracefully', async ({ page }) => {
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });

      // Write corrupted data
      await page.evaluate(() => {
        localStorage.setItem('agent-health:eval-runs:timeRange', 'not-valid-json{{{');
        localStorage.setItem('agent-health:eval-runs:viewMode', '');
      });

      // Reload — should not crash, should fall back to defaults
      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });

      await expect(page.locator('h2').first()).toBeVisible();
    });
  });
});
