/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Regression: the Evaluation Run detail page must display stats derived
 * from the persisted per-test-case verdicts (`run.results[*].passFailStatus`),
 * NOT the denormalized `run.stats` blob.
 *
 * Root cause (trace-judged path bug): `waitForTracesAndJudge` wrote the real
 * judge verdict to storage but returned void, so the caller in
 * `services/evaluationRunner.ts` never saw it and recorded every trace-judged
 * test case as a bare 'completed' with no verdict. The run-completion stats
 * loop then counted every 'completed' result as "passed" regardless of the
 * real verdict — a run with (say) 66/84 real "passed" judgments displayed as
 * 84/84 passed.
 *
 * This spec seeds an evaluation-run doc where `run.stats` still has the OLD
 * buggy shape (every case counted as passed) but `run.results` carries the
 * real per-test-case verdicts (2 passed / 2 failed). If the detail page ever
 * regresses to trusting `run.stats` directly, this test fails by asserting
 * the buggy numbers are NOT shown and the real numbers ARE.
 */

const RUN_ID = 'eval-run-e2e-trace-judge-stats';
const TC_PASS_1 = 'tc-e2e-tjs-pass-1';
const TC_PASS_2 = 'tc-e2e-tjs-pass-2';
const TC_FAIL_1 = 'tc-e2e-tjs-fail-1';
const TC_FAIL_2 = 'tc-e2e-tjs-fail-2';

function evalRunDoc() {
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: 'E2E Trace-Judged Stats Run',
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    // Real per-test-case verdicts (what the trace judge actually decided,
    // persisted correctly on each report AND — post-fix — on run.results).
    results: {
      [TC_PASS_1]: { reportId: `report-${TC_PASS_1}`, status: 'completed', passFailStatus: 'passed' },
      [TC_PASS_2]: { reportId: `report-${TC_PASS_2}`, status: 'completed', passFailStatus: 'passed' },
      [TC_FAIL_1]: { reportId: `report-${TC_FAIL_1}`, status: 'completed', passFailStatus: 'failed' },
      [TC_FAIL_2]: { reportId: `report-${TC_FAIL_2}`, status: 'completed', passFailStatus: 'failed' },
    },
    // The OLD buggy denormalized stats: every 'completed' result counted as
    // passed regardless of verdict (pre-fix `evaluationRunner.ts` behavior).
    // A regression that goes back to trusting this blob directly would show
    // 4/4 passed here instead of the real 2/2.
    stats: { passed: 4, failed: 0, pending: 0, errored: 0, total: 4 },
  };
}

test.describe('Evaluation Run Detail Page — stats reflect real verdicts, not stale run.stats', () => {
  test('shows passed/failed computed from run.results, not the buggy denormalized run.stats', async ({ page }) => {
    const api = page.request;
    try {
      const seeded = await api.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: evalRunDoc() });
      expect(seeded.ok()).toBeTruthy();

      await page.goto(`/evaluations/runs/${RUN_ID}`);
      await expect(page.getByText('EVALUATION RUN', { exact: true })).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1000);

      // Real verdicts: 2 passed, 2 failed, 4 total — NOT the buggy 4 passed.
      await expect(page.locator('text=Passed').first()).toBeVisible();

      const passedValue = page.locator('div.text-2xl.font-bold.text-green-600');
      const failedValue = page.locator('div.text-2xl.font-bold.text-red-600');
      // Assert the REAL numbers are shown — this is what regresses to '4'/'0'
      // if the page ever goes back to trusting the stale run.stats blob.
      await expect(passedValue).toHaveText('2');
      await expect(failedValue).toHaveText('2');
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
    }
  });
});
