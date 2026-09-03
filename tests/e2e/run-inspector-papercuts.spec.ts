/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: two run-inspector papercuts.
 *
 * 1. Dead pane on load — the inspector opened with the case list already
 *    populated (failed/errored/passed rows) but the main pane still said
 *    "Select a test case" because nothing pre-selected the first row.
 * 2. Re-run provenance chip crowding the title — a long source-run name
 *    used to wrap the "re-run of <source>" pill onto multiple lines,
 *    fighting the (truncated) run title for vertical space. The identical
 *    chip exists on TWO pages -- RunInspectorPage.tsx's split-panel
 *    inspector (/evaluations/runs/:id/inspect) and EvalRunDetailPage.tsx's
 *    report page (/evaluations/runs/:id) -- both are covered below.
 *
 * Data is seeded through the storage API and cleaned up via the shared
 * TestDataTracker + crash ledger (mirrors rerun-evaluation-run.spec.ts /
 * lazy-report-loading.spec.ts).
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Run inspector — auto-select first case on load', () => {
  const tracker = createTestDataTracker();
  let runId: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    const testCaseIds: string[] = [];
    const reportIds: string[] = [];

    // Three test cases, one of each status so the left list shows a
    // FAILED/ERRORED/PASSED mix, mirroring the owner's screenshot.
    for (let i = 0; i < 3; i++) {
      const tcRes = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`inspector-papercut-tc-${i}`),
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      });
      if (!tcRes.ok()) return;
      const tc = await tcRes.json();
      const tcId = tc.id || tc.testCase?.id;
      if (!tcId) return;
      testCaseIds.push(tcId);
      tracker.testCase(tcId);
    }

    const statuses: Array<{ passFailStatus: string | null; metricsStatus: string }> = [
      { passFailStatus: 'failed', metricsStatus: 'ready' },
      { passFailStatus: null, metricsStatus: 'error' },
      { passFailStatus: 'passed', metricsStatus: 'ready' },
    ];
    testCaseIds.forEach((tcId, i) => {
      reportIds.push(`report-e2e-inspector-papercut-${stamp}-${i}`);
    });
    const bulkRes = await request.post('/api/storage/runs/bulk', {
      data: {
        runs: testCaseIds.map((tcId, i) => ({
          id: reportIds[i],
          testCaseId: tcId,
          testCaseVersionId: `${tcId}-v1`,
          agentId: 'demo',
          modelId: 'demo-model',
          iteration: 1,
          status: 'completed',
          trajectory: [{ type: 'assistant', content: `step for ${tcId}` }],
          ...statuses[i],
        })),
      },
    });
    tracker.trackAll('run', reportIds);
    if (!bulkRes.ok()) return;

    runId = `eval-run-e2e-inspector-papercut-${stamp}`;
    const results: Record<string, { reportId: string; status: string }> = {};
    testCaseIds.forEach((tcId, i) => { results[tcId] = { reportId: reportIds[i], status: 'completed' }; });
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: uniqueTestName('inspector-papercut-run'),
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: testCaseIds }],
        trigger: 'api',
        testCaseSnapshots: [],
        results,
        createdAt: new Date().toISOString(),
      },
    });
    tracker.evaluationRun(runId);
    seeded = runRes.ok();
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('a case is auto-selected and its detail renders -- no dead "Select a test case" pane', async ({ page }) => {
    test.skip(!seeded, 'Could not seed evaluation run (storage not configured?)');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    // List populated with the mixed statuses.
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('[data-testid="test-case-row"][data-status="failed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="test-case-row"][data-status="errored"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="test-case-row"][data-status="passed"]')).toHaveCount(1);

    // The dead-pane message never appears.
    await expect(page.getByText('Select a test case')).toHaveCount(0);

    // Some row is visually selected (blue left border) and the right pane
    // shows real content, not the empty placeholder.
    await expect(page.locator('[data-testid="test-case-row"].border-l-blue-500')).toHaveCount(1);
  });

  test('reloading the page keeps a case selected (no regression to the dead pane on refresh)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed evaluation run (storage not configured?)');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByText('Select a test case')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByText('Select a test case')).toHaveCount(0);
    await expect(page.locator('[data-testid="test-case-row"].border-l-blue-500')).toHaveCount(1);
  });
});

test.describe('Run inspector — compact re-run provenance chip', () => {
  let testCaseId: string | null = null;
  let sourceRunId: string | null = null;
  let childRunId: string | null = null;
  let seeded = false;

  // Deliberately long -- this is exactly the shape that used to wrap the
  // pill onto multiple lines. Kept generic/non-identifying per repo policy.
  const LONG_SOURCE_NAME = uniqueTestName('inspector-papercut-source') +
    ' — full regression sweep across the staging benchmark with trajectory capture and judge validation enabled end to end';

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('inspector-papercut-chip-tc'),
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'p',
        expectedOutcomes: ['o'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    sourceRunId = `eval-run-e2e-inspector-papercut-src-${Date.now()}`;
    const srcRes = await request.put(`/api/storage/evaluation-runs/${sourceRunId}`, {
      data: {
        id: sourceRunId,
        name: LONG_SOURCE_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [],
        results: {},
        createdAt: new Date().toISOString(),
      },
    });
    if (!srcRes.ok()) return;

    childRunId = `eval-run-e2e-inspector-papercut-child-${Date.now()}`;
    const childRes = await request.put(`/api/storage/evaluation-runs/${childRunId}`, {
      data: {
        id: childRunId,
        name: 'Full Regression Retrieval Agent Evaluation Run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'ui',
        testCaseSnapshots: [],
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

  test('chip stays single-line and the title is not squeezed by a long source name -- EvalRunDetailPage (/evaluations/runs/:id)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source/child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('re-run of');

    // Single-line: a wrapped multi-line pill would be roughly 2x this tall.
    // text-xs (~16px line-height) + py-0.5 (2px top/bottom) + border (~2px)
    // is comfortably under 30px for one line; a wrap would push this past 40.
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(30);

    // The full source name is available via the tooltip, not the visible
    // (truncated) label.
    await expect(chip).toHaveAttribute('title', new RegExp(LONG_SOURCE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // The run's own title keeps a tooltip with the full name too.
    const title = page.getByRole('heading', { level: 1, name: 'Full Regression Retrieval Agent Evaluation Run' });
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute('title', 'Full Regression Retrieval Agent Evaluation Run');
  });

  test('chip stays single-line and the title is not squeezed by a long source name -- RunInspectorPage (/evaluations/runs/:id/inspect)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source/child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('re-run of');

    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(30);

    await expect(chip).toHaveAttribute('title', new RegExp(LONG_SOURCE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // The run's own title (the inline-rename field) keeps its normal
    // single-line height too -- the chip isn't stealing its vertical space --
    // and carries a tooltip with the full (untruncated) name.
    const title = page.getByTestId('run-inspector-rename-text');
    await expect(title).toBeVisible();
    const titleBox = await title.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(titleBox!.height).toBeLessThan(30);
    await expect(title).toHaveAttribute('title', 'Full Regression Retrieval Agent Evaluation Run');
  });

  test('chip click still navigates to the source run', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source/child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();

    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${sourceRunId}$`), { timeout: 10_000 });
  });
});
