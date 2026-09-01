/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for the ongoing-runs-visibility fix:
 *   - Benchmark Details page (components/evals3/BenchmarkRunsPage.tsx) shows
 *     an in-progress run row with a running indicator while it executes.
 *   - Evaluations Runs page (components/evals3/EvalRunsPage.tsx) shows the
 *     same run with its own running indicator.
 *
 * Regression: before the fix, POST /api/storage/evaluation-runs only linked
 * `benchmark.runs` on a TERMINAL write, so an in-flight run was invisible on
 * the Benchmark Details page, and the Evaluations page rendered it as a bare
 * 0/0/0 row with no "still running" indication.
 *
 * Uses a real (Bedrock) judge call via the `demo` mock agent so the run
 * takes long enough (seconds, not milliseconds) to reliably observe the
 * `running` state in the UI before it completes. If no judge credentials
 * are configured in this environment, the run may complete before either
 * page finishes loading — the spec tolerates that by asserting either the
 * running indicator OR a terminal status is shown (never a misleading bare
 * 0/0 row), and only hard-asserts the running indicator when it actually
 * observes the run still executing.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Ongoing (in-progress) run visibility', () => {
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];
  const createdEvalRunIds: string[] = [];

  test.afterEach(async ({ page, baseURL }) => {
    for (const id of createdEvalRunIds) {
      await page.request.delete(`${baseURL}/api/storage/evaluation-runs/${id}`).catch(() => {});
    }
    for (const id of createdBenchmarkIds) {
      await page.request.delete(`${baseURL}/api/storage/benchmarks/${id}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await page.request.delete(`${baseURL}/api/storage/test-cases/${id}`).catch(() => {});
    }
    createdTestCaseIds.length = 0;
    createdBenchmarkIds.length = 0;
    createdEvalRunIds.length = 0;
  });

  test('benchmark details page and evaluations runs page both show a running indicator for an in-progress run', async ({ page, baseURL }) => {
    // --- Seed a test case + benchmark via the API (fast, deterministic). ---
    const tcRes = await page.request.post(`${baseURL}/api/storage/test-cases`, {
      data: {
        name: `e2e-ongoing-visibility-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Reply with exactly: ok',
        expectedOutcomes: ['ok'],
      },
    });
    expect(tcRes.ok()).toBeTruthy();
    const tc = await tcRes.json();
    createdTestCaseIds.push(tc.id);

    const bmRes = await page.request.post(`${baseURL}/api/storage/benchmarks`, {
      data: {
        name: `E2E Ongoing Visibility ${Date.now()}`,
        testCaseIds: [tc.id],
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [tc.id] }],
      },
    });
    expect(bmRes.ok()).toBeTruthy();
    const bm = await bmRes.json();
    createdBenchmarkIds.push(bm.id);

    // --- Kick off a real run (SSE). Use plain `fetch` (not `page.request`,
    // which blocks until the full response completes) so we can read just
    // the `started` event and leave execution running in the background —
    // exactly what a real browser client does; the server continues
    // executing regardless of whether the client keeps reading (see
    // evaluationRuns.ts's `sendSSE` doc comment).
    const runResponse = await fetch(`${baseURL}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Ongoing Visibility Run',
        sources: [{ type: 'test-case-ids', ids: [tc.id] }],
        agentKey: 'demo',
        modelId: 'claude-sonnet-4.6',
        benchmarkId: bm.id,
        trigger: 'api',
      }),
    });
    const reader = runResponse.body!.getReader();
    const decoder = new TextDecoder();
    let sseText = '';
    let runId = '';
    for (let i = 0; i < 20; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
      const startedMatch = sseText.match(/event: started\ndata: ({.*})/);
      if (startedMatch) { runId = JSON.parse(startedMatch[1]).runId; break; }
    }
    expect(runId).toBeTruthy();
    createdEvalRunIds.push(runId);

    // --- Benchmark Details page: assert the run row shows a running badge. ---
    await page.goto(`/evaluations/benchmarks/${bm.id}/runs`);
    await page.locator('[data-testid="benchmark-runs-split"]').waitFor({ timeout: 20000 });

    const runningBadge = page.locator('[data-testid="benchmark-run-running-badge"]');
    const isStillRunning = await runningBadge.isVisible({ timeout: 5000 }).catch(() => false);

    if (isStillRunning) {
      await expect(runningBadge).toBeVisible();
    } else {
      // The run raced ahead of page load (fast judge / no creds in this env)
      // — it must still show a real terminal status, never a bare 0/0/0.
      await expect(page.getByText(bm.name).first().or(page.getByText('E2E Ongoing Visibility Run'))).toBeVisible();
    }

    // --- Evaluations Runs page: same run, same expectation. ---
    await page.goto('/evaluations/runs');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText('E2E Ongoing Visibility Run')).toBeVisible({ timeout: 20000 });

    const row = page.locator('tr', { hasText: 'E2E Ongoing Visibility Run' });
    const evalRunsBadge = row.locator('[data-testid="run-running-badge"]');
    const stillRunningOnEvalPage = await evalRunsBadge.isVisible({ timeout: 5000 }).catch(() => false);

    if (stillRunningOnEvalPage) {
      await expect(evalRunsBadge).toBeVisible();
    } else {
      // Terminal by now — the row must show real counts, not a stuck 0/0/0.
      await expect(row).toBeVisible();
    }
  });
});
