/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * e2e regression for the benchmark-runs-page union fix: a run-first
 * (`eval-run-…`) `EvaluationRun` that references a benchmark via
 * `benchmarkId` — but was never embedded into `benchmark.runs[]` — must
 * still render on `/evaluations/benchmarks/:id/runs`. Pre-fix, that page
 * only ever read `benchmark.runs[]`, so every CLI run created via
 * `benchmark -f foo.eval.js -n "..."` (the unified/code-import path)
 * rendered an empty runs list even though the run existed and
 * `GET /api/storage/evaluation-runs?benchmarkId=<id>` returned it fine.
 *
 * Seeds a shell benchmark (`testCaseIds: []`) + a completed run-first run
 * directly via the storage API (no agent execution needed — this is a UI
 * rendering regression, not a judging one) and asserts the run row shows up
 * with its real name, and that clicking it routes to the SDK eval-run
 * inspector (not the benchmark-scoped route, which would 404-navigate-away
 * since the run isn't in bm.runs[]).
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Benchmark Runs Page: run-first (CLI) run union', () => {
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  let testCaseId: string | null = null;
  const runName = `CLI-first-run-e2e-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: 'E2E Run-First Union Test Case',
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
        labels: ['@e2e-run-first-union'],
      },
    });
    if (tcRes.ok()) {
      const tcData = await tcRes.json();
      testCaseId = tcData.id || tcData.testCase?.id;
    }

    // Shell benchmark — testCaseIds deliberately empty, mirroring a
    // CLI-created benchmark before the run-first run gets linked.
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: 'E2E Run-First Union Benchmark',
        description: 'Seeded shell benchmark for the run-first union e2e test',
        testCaseIds: [],
      },
    });
    if (bmRes.ok()) {
      const bmData = await bmRes.json();
      benchmarkId = bmData.id || bmData.benchmark?.id;
    }

    if (benchmarkId && testCaseId) {
      runId = `eval-run-e2e-union-${Date.now()}`;
      await request.put(`/api/storage/evaluation-runs/${runId}`, {
        data: {
          id: runId,
          name: runName,
          status: 'completed',
          agentKey: 'demo',
          modelId: 'demo-model',
          sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
          trigger: 'cli',
          testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'E2E Run-First Union Test Case' }],
          results: {},
          benchmarkId,
          createdAt: new Date().toISOString(),
        },
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${encodeURIComponent(runId)}`).catch(() => {});
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${encodeURIComponent(testCaseId)}`).catch(() => {});
  });

  test('renders the run-first run row on the benchmark runs page', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Seed data not created');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });

    // The regression: this run is NOT in benchmark.runs[] — it only exists
    // as a run-first EvaluationRun doc. Pre-fix, the page rendered "No runs
    // yet" here despite the run existing server-side.
    await expect(page.locator(`text=${runName}`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=No runs yet')).not.toBeVisible();
  });

  test('clicking the run-first run routes to the SDK eval-run inspector, not a 404 benchmark-scoped lookup', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Seed data not created');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await page.locator(`text=${runName}`).click();

    // runInspectPath() routes run-first rows to /evaluations/runs/:id/inspect
    // (no benchmarkId segment) — the benchmark-scoped route 404s away since
    // RunInspectorPage's benchmark mode looks the run up via bm.runs.find().
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${runId}/inspect`));
  });
});
