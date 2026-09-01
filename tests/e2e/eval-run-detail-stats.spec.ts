/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Regression: the Evaluation Run detail page must display stats derived
 * from the persisted per-test-case verdicts (report docs'
 * `passFailStatus`), NOT the denormalized `run.stats` blob.
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
 * buggy shape (every case counted as passed) but the real per-test-case
 * reports carry the real verdicts (2 passed / 2 failed). If the canonical
 * run page (RunInspectorPage, run-experience convergence Phase 1) ever
 * regresses to trusting `run.stats` directly, this test fails by asserting
 * the buggy numbers are NOT shown and the real numbers ARE.
 *
 * Seeds real report docs (not just `run.results[*].passFailStatus`) because
 * RunInspectorPage's tally reads the fetched report summaries
 * (`getReportSummariesByIds`), same as the rest of the inspector's status
 * logic (`getResultStatus`) — a stricter, report-doc-backed path than the
 * old EvalRunDetailPage's `computeRunStats(run.results)` shortcut.
 */

const RUN_ID = 'eval-run-e2e-trace-judge-stats';
const TC_PASS_1 = 'tc-e2e-tjs-pass-1';
const TC_PASS_2 = 'tc-e2e-tjs-pass-2';
const TC_FAIL_1 = 'tc-e2e-tjs-fail-1';
const TC_FAIL_2 = 'tc-e2e-tjs-fail-2';

function reportDoc(testCaseId: string, passFailStatus: 'passed' | 'failed') {
  return {
    testCaseId,
    agentName: 'Agent Alpha',
    agentKey: 'agent-alpha',
    modelName: 'e2e-model',
    modelId: 'e2e-model',
    status: 'completed' as const,
    passFailStatus,
    timestamp: new Date().toISOString(),
  };
}

test.describe('Evaluation Run Detail Page — stats reflect real verdicts, not stale run.stats', () => {
  test('shows passed/failed computed from real per-test-case reports, not the buggy denormalized run.stats', async ({ page }) => {
    const api = page.request;
    const reportIds: Record<string, string> = {};

    try {
      // Seed the 4 real report docs (the source of truth this page reads).
      for (const [tcId, verdict] of [
        [TC_PASS_1, 'passed'],
        [TC_PASS_2, 'passed'],
        [TC_FAIL_1, 'failed'],
        [TC_FAIL_2, 'failed'],
      ] as const) {
        const res = await api.post('/api/storage/runs', { data: reportDoc(tcId, verdict) });
        expect(res.ok()).toBeTruthy();
        reportIds[tcId] = (await res.json()).id;
      }

      const evalRunDoc = {
        id: RUN_ID,
        docType: 'evaluation-run',
        name: 'E2E Trace-Judged Stats Run',
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'agent-alpha',
        modelId: 'e2e-model',
        sources: [],
        trigger: 'api',
        testCaseSnapshots: [TC_PASS_1, TC_PASS_2, TC_FAIL_1, TC_FAIL_2].map(id => ({ id, version: 1, name: id })),
        results: {
          [TC_PASS_1]: { reportId: reportIds[TC_PASS_1], status: 'completed' },
          [TC_PASS_2]: { reportId: reportIds[TC_PASS_2], status: 'completed' },
          [TC_FAIL_1]: { reportId: reportIds[TC_FAIL_1], status: 'completed' },
          [TC_FAIL_2]: { reportId: reportIds[TC_FAIL_2], status: 'completed' },
        },
        // The OLD buggy denormalized stats: every 'completed' result counted as
        // passed regardless of verdict (pre-fix `evaluationRunner.ts` behavior).
        // A regression that goes back to trusting this blob directly would show
        // 4/4 passed here instead of the real 2/2.
        stats: { passed: 4, failed: 0, pending: 0, errored: 0, total: 4 },
      };
      const seeded = await api.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: evalRunDoc });
      expect(seeded.ok()).toBeTruthy();

      await page.goto(`/evaluations/runs/${RUN_ID}`);
      await expect(page.locator('[data-testid="run-inspector-name"]')).toBeVisible({ timeout: 15000 });

      // Real verdicts: 2 passed, 2 failed, 4 total — NOT the buggy 4 passed.
      const stats = page.locator('[data-testid="run-inspector-stats"]');
      await expect(stats).toContainText('2✓');
      await expect(stats).toContainText('2✗');
      await expect(stats).toContainText('/ 4');
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
      for (const id of Object.values(reportIds)) {
        await api.delete(`/api/storage/runs/${id}`).catch(() => {});
      }
    }
  });
});
