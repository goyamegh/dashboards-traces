/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: checkpoint-resume (#414) works end-to-end from the CANONICAL run page
 * (/evaluations/runs/:runId, run-experience convergence Phase 1) — not just
 * that the button renders (resume-run.spec.ts covers the UI contract with a
 * mocked SSE response). This test lets the real `demo` agent execute the
 * resumed test case and asserts the page reaches a genuinely completed state
 * with correct pass/fail stats and the Resume button gone, without ever
 * leaving the canonical URL.
 *
 * Seeds a run with one test case already completed (a real, separately
 * executed report — not a fabricated passFailStatus) and one pending, status
 * 'cancelled' — the same "cancelled after 1 of 2 test cases" shape as the
 * manual live-cluster verification for the #414/run-experience convergence
 * pass. Regression target: RunInspectorPage's running-poll (added during
 * that convergence pass) — before it existed, the page never refreshed
 * itself after a resume until the whole SSE stream settled.
 */
import { test, expect } from './fixtures/test-fixtures';

test.describe('Checkpoint-resume completes end-to-end from the canonical run page', () => {
  test('resume executes the pending test case for real and the canonical page reflects completion', async ({ page, request, testData }) => {
    // Two real test cases (demo agent, fast + free).
    const tcRes1 = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-canonical-resume-tc1-${Date.now()}`,
        category: 'Diagnostics', difficulty: 'Easy',
        initialPrompt: 'Say hello and nothing else.',
        expectedOutcomes: ['Agent responds with a greeting'],
      },
    });
    expect(tcRes1.ok()).toBeTruthy();
    const tc1 = (await tcRes1.json()).id;
    testData.testCase(tc1);

    const tcRes2 = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-canonical-resume-tc2-${Date.now()}`,
        category: 'Diagnostics', difficulty: 'Easy',
        initialPrompt: 'Say hello and nothing else.',
        expectedOutcomes: ['Agent responds with a greeting'],
      },
    });
    expect(tcRes2.ok()).toBeTruthy();
    const tc2 = (await tcRes2.json()).id;
    testData.testCase(tc2);

    // Real execution of tc1 only, to get a genuine completed report (not a
    // fabricated passFailStatus) — mirrors the manual live-cluster
    // verification technique for this convergence pass.
    const seedRunId = `eval-run-e2e-canonical-resume-seed-${Date.now()}`;
    const seedRes = await request.put(`/api/storage/evaluation-runs/${seedRunId}`, {
      data: {
        id: seedRunId, name: 'seed', status: 'pending', agentKey: 'demo', modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [tc1] }], trigger: 'api',
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'tc1' }], results: {},
        createdAt: new Date().toISOString(),
      },
    });
    expect(seedRes.ok()).toBeTruthy();
    const resumed = await request.post(`/api/storage/evaluation-runs/${seedRunId}/resume`);
    expect(resumed.ok()).toBeTruthy();
    // The resume endpoint streams SSE; wait for the run to settle, then read
    // the real report id it produced for tc1.
    await expect.poll(async () => {
      const r = await request.get(`/api/storage/evaluation-runs/${seedRunId}`);
      return (await r.json()).status;
    }, { timeout: 30_000 }).toBe('completed');
    const seedRun = await (await request.get(`/api/storage/evaluation-runs/${seedRunId}`)).json();
    const tc1ReportId = seedRun.results[tc1].reportId;
    expect(tc1ReportId).toBeTruthy();
    testData.run(tc1ReportId);
    await request.delete(`/api/storage/evaluation-runs/${seedRunId}`).catch(() => {});

    // The real verification run: tc1 already completed (real report), tc2
    // pending, status 'cancelled' — exactly the checkpoint-resume shape.
    const runId = `eval-run-e2e-canonical-resume-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: 'E2E canonical-page resume',
        sources: [{ type: 'test-case-ids', ids: [tc1, tc2] }],
        agentKey: 'demo', modelId: 'demo-model', trigger: 'api', concurrency: 1,
        status: 'cancelled', error: 'cancelled after 1 of 2 test cases (e2e seed)',
        createdAt: new Date().toISOString(),
        testCaseSnapshots: [
          { id: tc1, version: 1, name: 'tc1' },
          { id: tc2, version: 1, name: 'tc2' },
        ],
        results: {
          [tc1]: { reportId: tc1ReportId, status: 'completed', passFailStatus: 'passed' },
          [tc2]: { reportId: '', status: 'pending' },
        },
      },
    });
    expect(runRes.ok()).toBeTruthy();
    testData.evaluationRun(runId);

    // Drive the resume from the CANONICAL page.
    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="run-inspector-name"]', { timeout: 20000 });

    const resumeBtn = page.locator('[data-testid="inspector-resume-btn"]');
    await expect(resumeBtn).toBeVisible({ timeout: 15000 });
    await expect(resumeBtn).toContainText('Resume (1 left)');

    // Clear the sidebar hover-zone before clicking (see the RunInspectorPage
    // fix commit + rerun-evaluation-run.spec.ts for why).
    await page.mouse.move(700, 400);
    await page.waitForTimeout(300);
    await resumeBtn.click();

    // Never navigates away — must stay on the canonical URL throughout.
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${runId}$`));

    // The canonical page must reach a genuinely completed state on its own
    // (via the running-poll fixed during this convergence pass), without a
    // manual reload.
    await expect(page.locator('[data-testid="run-inspector-status-badge"]'))
      .toHaveText('completed', { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${runId}$`));
    await expect(page.locator('[data-testid="run-inspector-stats"]')).toContainText('2✓');
    await expect(page.locator('[data-testid="run-inspector-stats"]')).toContainText('0✗');
    await expect(page.locator('[data-testid="run-inspector-stats"]')).toContainText('/ 2');
    // Nothing left to resume.
    await expect(page.locator('[data-testid="inspector-resume-btn"]')).toHaveCount(0);

    // Track the report the real resume execution produced for cleanup.
    const finalRun = await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json();
    const tc2ReportId = finalRun.results?.[tc2]?.reportId;
    if (tc2ReportId) testData.run(tc2ReportId);
  });
});
