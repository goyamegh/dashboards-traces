/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: judge identity for CODE-SDK reports — inspector Judge tab + the
 * benchmark Runs tab "J. Model" column.
 *
 * Owner-verified miss (2026-09-27): a run of code-SDK test cases judged by the
 * agent trace judge persisted reports whose only judge record was
 * `matcherResults[].model = 'agent-trace-judge'` (a PROVIDER pseudo-id) — no
 * `judgeModel`, no kind — so the UI showed the provider with no model name.
 * The fix rolls the resolved LLM up to `report.judgeModel` / `judgeProvider`
 * (and the run), and marks bodies that never called `judge()` with
 * `judgeProvider: 'none'`.
 *
 * Seeds (via the storage API, same shape the runner now persists):
 *   - an SDK report with two `judge()` matchers → Judge tab reads
 *     "Judge model: Agent Trace Judge … · claude-sonnet-4-5 · 2 judge calls"
 *   - an SDK report with code assertions only → "No LLM judge — code
 *     assertions only"
 *   - two benchmark runs carrying the same identities → the Runs tab
 *     "J. Model" cells read "… · claude-sonnet-4-5" / "No LLM judge · code
 *     assertions only" instead of the bare provider name.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

test.describe('Code-SDK judge identity — inspector Judge tab + Runs tab J. Model', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let testCaseId: string | null = null;
  const stamp = Date.now();
  const judgedReportId = `report-e2e-sdk-judged-${stamp}`;
  const detReportId = `report-e2e-sdk-det-${stamp}`;
  const judgedRunId = `run-e2e-sdk-judged-${stamp}`;
  const detRunId = `run-e2e-sdk-det-${stamp}`;
  const JUDGED_RUN = uniqueTestName('sdk-judge-identity-judged');
  const DET_RUN = uniqueTestName('sdk-judge-identity-deterministic');

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('sdk-judge-identity-tc'),
        category: 'Test', difficulty: 'Easy',
        initialPrompt: 'Summarize the incident.',
        expectedOutcomes: ['names the failing component'],
      },
    });
    if (!tcRes.ok()) return;
    const tcJson = await tcRes.json();
    testCaseId = tcJson.id || tcJson.testCase?.id;
    tracker.testCase(testCaseId);

    const baseReport = {
      testCaseId,
      testCaseVersionId: `${testCaseId}-v1`,
      agentId: 'demo',
      modelId: 'demo-model',
      judgeModelId: 'agent-trace-judge',
      iteration: 1,
      status: 'completed',
      passFailStatus: 'passed',
      metricsStatus: 'completed',
      evaluationType: 'deterministic',
      llmJudgeReasoning: '',
      trajectory: [{ type: 'assistant', content: 'The search service timed out; restart it.' }],
    };
    const bulk = await request.post('/api/storage/runs/bulk', {
      data: {
        runs: [
          {
            ...baseReport,
            id: judgedReportId,
            judgeModel: SONNET_45,
            judgeProvider: 'agent',
            matcherResults: [
              { description: 'result.trajectory to have length above 0', pass: true, method: 'code-assertion', actual: 1, expected: 0 },
              { description: 'judge: 2 claims', pass: true, method: 'llm-judge', role: 'observe', durationMs: 1200, score: 0.9, reasoning: 'Both claims hold.', model: 'agent-trace-judge', judgeModel: SONNET_45, judgeProvider: 'agent' },
              { description: 'judge: proposes a remediation', pass: true, method: 'llm-judge', role: 'gate', durationMs: 900, score: 0.85, reasoning: 'A restart is proposed.', model: 'agent-trace-judge', judgeModel: SONNET_45, judgeProvider: 'agent' },
            ],
          },
          {
            ...baseReport,
            id: detReportId,
            judgeProvider: 'none',
            matcherResults: [
              { description: 'result.trajectory to have length above 0', pass: true, method: 'code-assertion', actual: 1, expected: 0 },
            ],
          },
        ],
      },
    });
    if (!bulk.ok()) return;
    tracker.run(judgedReportId);
    tracker.run(detReportId);

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('sdk-judge-identity-bm'),
        description: 'sdk judge identity e2e',
        testCaseIds: [testCaseId], runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const mkRun = (id: string, name: string, reportId: string, identity: Record<string, unknown>) => ({
      id, name, agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'agent-trace-judge', ...identity,
      createdAt: new Date().toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'case' }],
      results: { [testCaseId!]: { reportId, status: 'completed', passFailStatus: 'passed' } },
    });
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
        runs: [
          mkRun(judgedRunId, JUDGED_RUN, judgedReportId, { judgeModel: SONNET_45, judgeProvider: 'agent' }),
          mkRun(detRunId, DET_RUN, detReportId, { judgeProvider: 'none' }),
        ],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('inspector Judge tab: SDK report shows the resolved judge LLM and the judge-call count', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${judgedRunId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="test-case-row"]').first().click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    const strip = page.getByTestId('sdk-judge-identity');
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.getByTestId('judge-model-kind')).toContainText(/Agent Trace Judge|agent-trace-judge/);
    await expect(strip.getByTestId('judge-model-resolved')).toContainText('claude-sonnet-4-5');
    await expect(strip.getByTestId('sdk-judge-call-count')).toHaveText('2 judge calls');
    await expect(page.getByTestId('sdk-judge-none')).toHaveCount(0);
    // the provider pseudo-id is never presented as "model not recorded" here
    await expect(strip.getByTestId('judge-model-not-recorded')).toHaveCount(0);
  });

  test('inspector Judge tab: deterministic-only SDK report says "No LLM judge — code assertions only"', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${detRunId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="test-case-row"]').first().click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    await expect(page.getByTestId('sdk-judge-none')).toContainText('No LLM judge — code assertions only', { timeout: 15_000 });
    await expect(page.getByTestId('sdk-judge-model')).toHaveCount(0);
  });

  test('benchmark Runs tab: "J. Model" shows the resolved LLM for the judged run and "No LLM judge" for the deterministic one', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await expect(page.getByTestId('benchmark-runs-table')).toBeVisible({ timeout: 30_000 });
    const rows = page.locator('[data-testid="run-row"]');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    const judgedRow = rows.filter({ hasText: JUDGED_RUN });
    await expect(judgedRow.getByTestId('run-cell-judge')).toContainText('claude-sonnet-4-5');
    await expect(judgedRow.getByTestId('run-cell-judge')).not.toHaveText(/^agent-trace-judge$/);

    const detRow = rows.filter({ hasText: DET_RUN });
    await expect(detRow.getByTestId('run-cell-judge')).toContainText('No LLM judge');
  });
});
