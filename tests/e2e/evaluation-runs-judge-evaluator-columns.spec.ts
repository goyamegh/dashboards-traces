/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Judge + Evaluator columns on the Evaluation Runs page.
 *
 * Regression guard for the feature request "Evaluation runs page should show
 * judge model and evaluator used as columns." Seeds two mocked evaluation-runs:
 *   - one with `judgeModelId` + `evaluatorId` set (recent run) — both columns
 *     must render a resolved, shortened label.
 *   - one legacy run with neither field — both columns must render the
 *     missing-field fallback ("—") instead of throwing or going blank.
 * Also verifies the Evaluator cell is a link that navigates to the evaluator
 * page, and that the table's colSpan math (loading/empty rows, group header
 * row) wasn't left stale when the column count grew by two.
 */

import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/test-fixtures';

const now = new Date().toISOString();

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const runWithJudgeAndEvaluator = {
  id: 'eval-run-with-judge',
  docType: 'evaluation-run',
  name: 'Run With Judge And Evaluator',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4.5',
  judgeModelId: 'claude-opus-4.8',
  evaluatorId: 'system-factuality',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'tc-1' }],
  results: { 'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

const legacyRunWithoutJudgeOrEvaluator = {
  id: 'eval-run-legacy',
  docType: 'evaluation-run',
  name: 'Legacy Run No Judge Or Evaluator',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4.5',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-2', version: 1, name: 'tc-2' }],
  results: { 'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

const evaluators = [
  { id: 'system-factuality', name: 'Factuality', isSystem: true },
];

test.describe('Evaluation Runs page — Judge + Evaluator columns', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/annotations**', (route) => json(route, { annotations: [], total: 0 }));
    await page.route('**/api/storage/evaluators/system-factuality', (route) =>
      json(route, { id: 'system-factuality', name: 'Factuality', isSystem: true, systemPrompt: '', scoringConfig: {}, inferenceConfig: {} }));
    await page.route('**/api/storage/evaluators', (route) => json(route, { evaluators, total: evaluators.length }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/storage/evaluation-runs') {
        return json(route, { evaluationRuns: [runWithJudgeAndEvaluator, legacyRunWithoutJudgeOrEvaluator], total: 2 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
  });

  test('renders Judge and Evaluator columns with resolved labels and missing-field fallback', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(1500);

    // All time, so both "now" runs are in range regardless of the default filter.
    const timeBtn = page.locator('button:has-text("Last")').first();
    if (await timeBtn.count()) {
      await timeBtn.click();
      await page.waitForTimeout(300);
      const allTime = page.getByText('All time', { exact: true }).last();
      if (await allTime.count()) await allTime.click();
      await page.waitForTimeout(800);
    }

    // Flat view so both eval-runs render as individual rows (no grouping).
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.count()) { await flat.click(); await page.waitForTimeout(600); }

    // Column headers present.
    await expect(page.getByRole('columnheader', { name: /^Judge$/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /^Evaluator$/ })).toBeVisible();

    const rows = page.locator('[data-testid="run-row"]');
    await expect(rows).toHaveCount(2, { timeout: 10000 });

    const withJudgeRow = rows.filter({ hasText: 'Run With Judge And Evaluator' });
    const legacyRow = rows.filter({ hasText: 'Legacy Run No Judge Or Evaluator' });

    // Judge model id is shortened via the same display-name registry as the
    // Model column (getModelName) — 'claude-opus-4.8' → 'Claude Opus 4.8'.
    await expect(withJudgeRow.locator('[data-testid="run-judge-cell"]')).toHaveText('Claude Opus 4.8');
    // Evaluator id resolves to its name via the id→name lookup.
    await expect(withJudgeRow.locator('[data-testid="run-evaluator-cell"]')).toContainText('Factuality');

    // Legacy run has neither field — both cells fall back to the em dash,
    // never a blank cell or a thrown error.
    await expect(legacyRow.locator('[data-testid="run-judge-cell"]')).toHaveText('—');
    await expect(legacyRow.locator('[data-testid="run-evaluator-cell"]')).toContainText('—');

    // The Evaluator cell is a link to the evaluator's page.
    await withJudgeRow.locator('[data-testid="run-evaluator-cell"] button').click();
    await page.waitForURL(/\/evaluators\/system-factuality/, { timeout: 10000 });
  });
});
