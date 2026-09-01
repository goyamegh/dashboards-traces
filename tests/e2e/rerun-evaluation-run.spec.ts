/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Re-run" an evaluation run — kicks off a duplicate of the same run.
 *
 * Covers the UI-visible surface of the feature (server behavior is covered
 * by tests/integration/.../evaluationRuns.rerun.integration.test.ts):
 *   - the Re-run button is visible on the run report page header
 *   - clicking it opens a confirm dialog with a name preview + agent/judge
 *     summary
 *   - confirming POSTs to the rerun endpoint and navigates to the new run's
 *     report page
 *   - the `rerunOf` provenance chip renders on a run created as a re-run,
 *     and links back to the source run
 *   - the Evaluation Runs list's per-row action opens the same dialog for
 *     an eval-run row
 *
 * Seeds its own deterministic test-case + evaluation-run docs via the
 * storage API (PUT upserts — PATCH requires the doc to already exist and
 * 404s otherwise) rather than relying on whatever runs happen to pre-exist,
 * and cleans them up in afterAll.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Re-run an evaluation run', () => {
  let testCaseId: string | null = null;
  let sourceRunId: string | null = null;
  let childRunId: string | null = null;
  let seeded = false;

  const SOURCE_NAME = 'E2E Rerun Source Run';

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-rerun-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is causing the outage?',
        expectedOutcomes: ['Identifies the root cause'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    sourceRunId = `eval-run-e2e-rerun-src-${Date.now()}`;
    const srcRes = await request.put(`/api/storage/evaluation-runs/${sourceRunId}`, {
      data: {
        id: sourceRunId,
        name: SOURCE_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        judgeModelId: 'claude-sonnet-4.6',
        evaluatorId: 'rca-default',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e rerun tc' }],
        results: {},
        createdAt: new Date().toISOString(),
      },
    });
    if (!srcRes.ok()) return;

    // A "child" run that was itself created as a re-run — for the
    // provenance-chip assertion. Seeded directly (not via the real rerun
    // endpoint) so this spec's chip assertion doesn't depend on the rerun
    // endpoint actually having run correctly — that's the integration
    // suite's job. This test only checks the chip renders + links back.
    childRunId = `eval-run-e2e-rerun-child-${Date.now()}`;
    const childRes = await request.put(`/api/storage/evaluation-runs/${childRunId}`, {
      data: {
        id: childRunId,
        name: `${SOURCE_NAME} (re-run)`,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'ui',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e rerun tc' }],
        results: {},
        createdAt: new Date().toISOString(),
        rerunOf: sourceRunId,
      },
    });
    seeded = childRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (childRunId) await request.delete(`/api/storage/evaluation-runs/${childRunId}`).catch(() => {});
    if (sourceRunId) await request.delete(`/api/storage/evaluation-runs/${sourceRunId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('Re-run button is visible on the run report page header', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="rerun-run-btn"]')).toBeVisible({ timeout: 15000 });
  });

  test('clicking Re-run opens a confirm dialog with name preview + agent/judge summary', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator('[data-testid="rerun-run-btn"]').click();

    const dialog = page.locator('[data-testid="rerun-confirm-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Name preview reflects the "(re-run)" suffix computed client-side.
    await expect(page.locator('[data-testid="rerun-name-preview"]')).toHaveText(`${SOURCE_NAME} (re-run)`);

    // Agent/judge summary present.
    await expect(dialog).toContainText('Agent:');
    await expect(dialog).toContainText('Judge:');
    // judgeModelId is displayed via getModelName() (human-readable), not the raw id.
    await expect(dialog).toContainText('Claude Sonnet 4.6');

    // Dismiss without submitting.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('confirming Re-run POSTs to the rerun endpoint and navigates to the new run\'s report page', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    let rerunRequested = false;
    await page.route(`**/api/storage/evaluation-runs/${sourceRunId}/rerun`, async route => {
      rerunRequested = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 'mocked-rerun-target',
          run: { id: 'mocked-rerun-target', name: `${SOURCE_NAME} (re-run)`, rerunOf: sourceRunId },
          defaultsApplied: [],
        }),
      });
    });

    await page.goto(`/evaluations/runs/${sourceRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator('[data-testid="rerun-run-btn"]').click();
    await expect(page.locator('[data-testid="rerun-confirm-dialog"]')).toBeVisible({ timeout: 10000 });

    await page.locator('[data-testid="rerun-confirm-btn"]').click();

    await expect(page).toHaveURL(/\/evaluations\/runs\/mocked-rerun-target$/, { timeout: 10000 });
    expect(rerunRequested).toBe(true);
  });

  test('provenance chip renders "re-run of <source>" on a run created as a re-run', async ({ page }) => {
    test.skip(!seeded, 'Could not seed child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toContainText('re-run of');
    await expect(chip).toContainText(SOURCE_NAME);

    // The chip links back to the source run's report page.
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${sourceRunId}$`), { timeout: 10000 });
    await expect(page.getByRole('heading', { name: SOURCE_NAME })).toBeVisible();
  });

  test('source run has no provenance chip (it was not itself a re-run)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="rerun-run-btn"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="rerun-provenance-chip"]')).toHaveCount(0);
  });

  test('Evaluation Runs list: row action opens the same confirm dialog for an eval-run row', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    // Narrow to the seeded source run so the row is unambiguous regardless
    // of whatever else exists in this backend.
    await page.getByPlaceholder('Search runs...').fill(SOURCE_NAME);

    const rowBtn = page.locator(`[data-testid="rerun-row-btn-${sourceRunId}"]`);
    await expect(rowBtn).toBeVisible({ timeout: 15000 });
    await rowBtn.click();

    const dialog = page.locator('[data-testid="rerun-confirm-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="rerun-name-preview"]')).toHaveText(`${SOURCE_NAME} (re-run)`);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('"Customize before re-running" opens the New-Run composer pre-filled from the source run', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const customizeBtn = page.locator('[data-testid="rerun-customize-btn"]');
    await expect(customizeBtn).toBeVisible({ timeout: 15000 });
    await customizeBtn.click();

    // Lands on the New-Run composer, pre-filled: run name starts "Re-run:".
    await expect(page).toHaveURL(/\/evaluations\/runs\/new$/);
    await expect(page.locator('input[placeholder="My evaluation run"]')).toHaveValue(/^Re-run:/, { timeout: 10000 });

    // There is NO agent-model picker in the composer (agent owns its model).
    await expect(page.getByText('Agent Model', { exact: true })).toHaveCount(0);
  });
});

test.describe('Run inspector — Re-run button (eval-run mode)', () => {
  let testCaseId: string | null = null;
  let sourceRunId: string | null = null;
  let childRunId: string | null = null;
  let seeded = false;

  const SOURCE_NAME = 'E2E Inspector Rerun Source Run';

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-inspect-rerun-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is causing the issue?',
        expectedOutcomes: ['Identifies the cause'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    sourceRunId = `eval-run-e2e-inspect-src-${Date.now()}`;
    const srcRes = await request.put(`/api/storage/evaluation-runs/${sourceRunId}`, {
      data: {
        id: sourceRunId,
        name: SOURCE_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e tc' }],
        results: {},
        createdAt: new Date().toISOString(),
      },
    });
    if (!srcRes.ok()) return;

    childRunId = `eval-run-e2e-inspect-child-${Date.now()}`;
    const childRes = await request.put(`/api/storage/evaluation-runs/${childRunId}`, {
      data: {
        id: childRunId,
        name: `${SOURCE_NAME} (re-run)`,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'ui',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e tc' }],
        results: {},
        createdAt: new Date().toISOString(),
        rerunOf: sourceRunId,
      },
    });
    seeded = childRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (childRunId) await request.delete(`/api/storage/evaluation-runs/${childRunId}`).catch(() => {});
    if (sourceRunId) await request.delete(`/api/storage/evaluation-runs/${sourceRunId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('Re-run button is visible in the inspector page header (eval-run mode)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    
    const rerunBtn = page.locator('[data-testid="inspector-rerun-btn"]');
    await expect(rerunBtn).toBeVisible({ timeout: 15000 });
    await expect(rerunBtn).not.toBeDisabled();
  });

  test('inspector Re-run button opens confirm dialog', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source run (storage not configured?)');

    await page.goto(`/evaluations/runs/${sourceRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    
    await page.locator('[data-testid="inspector-rerun-btn"]').click();

    const dialog = page.locator('[data-testid="rerun-confirm-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="rerun-name-preview"]')).toHaveText(`${SOURCE_NAME} (re-run)`);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('provenance chip renders in the inspector header', async ({ page }) => {
    test.skip(!seeded, 'Could not seed child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toContainText('re-run of');
    await expect(chip).toContainText(SOURCE_NAME);

    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${sourceRunId}$`), { timeout: 10000 });
  });
});

test.describe('Run inspector — Re-run button hidden for benchmark-embedded runs', () => {
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-inspect-bm-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'q',
        expectedOutcomes: ['a'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    benchmarkId = `e2e-inspect-bm-${Date.now()}`;
    runId = `e2e-inspect-bm-run-${Date.now()}`;
    
    const bmRes = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        id: benchmarkId,
        name: 'E2E Inspector BM',
        testCaseIds: [testCaseId],
        runs: [{
          id: runId,
          name: 'BM Run 1',
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          status: 'completed',
          createdAt: new Date().toISOString(),
          results: {},
        }],
      },
    });
    seeded = bmRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('Re-run button is disabled for benchmark-embedded runs', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const rerunBtn = page.locator('[data-testid="inspector-rerun-btn"]');
    await expect(rerunBtn).toBeVisible({ timeout: 15000 });
    await expect(rerunBtn).toBeDisabled();
  });
});
