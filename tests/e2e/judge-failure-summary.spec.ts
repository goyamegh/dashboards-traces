/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: run-level judge-failure surfacing (lib/judgeFailureSummary.ts).
 *
 * Reported incident: a run whose every case failed AT THE JUDGE STEP (the
 * agent-trace-judge's pre-fix "needs a runId or trace correlation hint" 400
 * for a non-instrumented REST agent) showed only a bare amber "⚠ N" count in
 * the runs list and nothing at all in the inspector — no reason anywhere.
 * These specs pin that `run.judgeFailureSummary` is rendered (a) as an
 * inspector banner and (b) as the runs-list errored-badge tooltip.
 *
 * Run doc + report are seeded via the storage API (unique names; cleaned
 * up in afterAll) — no agent/judge execution needed.
 */

import { test, expect } from './fixtures/test-fixtures';

const SUMMARY =
  '3/3 cases failed at the judge step: Bedrock Judge validation error (not retryable): ' +
  'The agent (trace) judge provider needs a runId or at least one trace correlation hint';

test.describe('Run-level judge failure summary', () => {
  let testCaseId: string | null = null;
  let runId: string | null = null;
  let reportId: string | null = null;
  let seeded = false;
  const RUN_NAME = `E2E Judge Failure Summary ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-judge-failure-tc-${Date.now()}`,
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

    // One errored report (canonical judge_failed shape) so the inspector's
    // errored count is > 0 alongside the banner.
    const repRes = await request.post('/api/storage/runs', {
      data: {
        testCaseId,
        agentName: 'Demo Agent',
        agentKey: 'demo',
        modelName: 'demo-model',
        modelId: 'demo-model',
        status: 'completed',
        metricsStatus: 'error',
        passFailStatus: null,
        traceError: 'Judge evaluation failed (kind=judge_failed): Bedrock Judge validation error (not retryable): needs a runId',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
        llmJudgeReasoning: '**Evaluator could not run.**',
      },
    });
    if (repRes.ok()) {
      const rep = await repRes.json();
      reportId = rep.id || rep.run?.id || rep.report?.id || null;
    }

    runId = `eval-run-e2e-judge-failure-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: RUN_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        judgeModelId: 'agent-trace-judge',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e judge failure tc' }],
        results: reportId ? { [testCaseId]: { reportId, status: 'completed' } } : {},
        stats: { passed: 0, failed: 0, errored: 1, pending: 0, total: 1 },
        judgeFailureSummary: SUMMARY,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    seeded = runRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (reportId) await request.delete(`/api/storage/runs/${reportId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('inspector shows the run-level judge-failure banner with the aggregated reason', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage unavailable)');
    await page.goto(`/evaluations/runs/${runId}/inspect`);
    const banner = page.getByTestId('run-judge-failure-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('3/3 cases failed at the judge step');
    await expect(banner).toContainText('needs a runId or at least one trace correlation hint');
  });

  test('runs list errored badge carries the judge-failure reason as its tooltip', async ({ page }) => {
    test.skip(!seeded || !reportId, 'Could not seed run/report (storage unavailable)');
    await page.goto('/evaluations/runs');
    const row = page.locator('tr', { hasText: RUN_NAME }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    const badge = row.getByTestId('run-row-errored-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', /Judge failure: 3\/3 cases failed at the judge step/);
  });
});
