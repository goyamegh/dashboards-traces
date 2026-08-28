/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * e2e for the "By benchmark" leaderboard tab of the dashboard's "Agents
 * Needing Improvement" widget.
 *
 * Seeds two disposable benchmarks via the storage API (mirroring
 * comparison-errored-passrate.spec.ts's pattern): "Bench A" has 3 agents
 * with distinct pass rates on the same 3 test cases; "Bench B" has a single
 * agent on its own 2 test cases. Bench A's run is dated far in the future
 * and Bench B's far in the past — deterministic sentinels so this test's
 * "most-recently-run benchmark" default holds regardless of any other
 * activity on the shared OpenSearch cluster all agent-health servers point
 * at (see AGENTS.md). All seeded ids are suffixed with Date.now() and
 * deleted in afterAll.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const FAR_PAST = '2015-01-01T00:00:00.000Z';

test.describe('Dashboard — Needs Improvement widget, By benchmark leaderboard', () => {
  const suffix = Date.now();
  const benchAName = `E2E Leaderboard Bench A ${suffix}`;
  const benchBName = `E2E Leaderboard Bench B ${suffix}`;

  const agentA = `e2e-lb-agent-a-${suffix}`;
  const agentB = `e2e-lb-agent-b-${suffix}`;
  const agentC = `e2e-lb-agent-c-${suffix}`;
  const agentD = `e2e-lb-agent-d-${suffix}`;

  const runAId = `run-lb-a-${suffix}`;
  const runBId = `run-lb-b-${suffix}`;
  const runCId = `run-lb-c-${suffix}`;
  const runDId = `run-lb-d-${suffix}`;

  let benchAId: string | null = null;
  let benchBId: string | null = null;
  const testCaseIds: string[] = [];
  const reportIds: string[] = [];
  let seeded = false;

  async function mkTestCase(request: APIRequestContext, name: string): Promise<string | null> {
    const r = await request.post('/api/storage/test-cases', {
      data: { name, category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
    });
    if (!r.ok()) return null;
    const j = await r.json();
    return j.id || j.testCase?.id || null;
  }

  async function mkReport(
    request: APIRequestContext,
    agentId: string,
    testCaseId: string,
    passFailStatus: 'passed' | 'failed'
  ): Promise<string | null> {
    const r = await request.post('/api/storage/runs', {
      data: {
        testCaseId,
        agentId,
        modelId: 'demo-model',
        status: 'completed',
        passFailStatus,
        metricsStatus: 'ready',
        metrics: { accuracy: passFailStatus === 'passed' ? 100 : 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
      },
    });
    if (!r.ok()) return null;
    return (await r.json()).id;
  }

  test.beforeAll(async ({ request }) => {
    // 3 shared test cases for Bench A (a benchmark runs the same cases across agents).
    const tcA = [
      await mkTestCase(request, `e2e-lb-tcA-0-${suffix}`),
      await mkTestCase(request, `e2e-lb-tcA-1-${suffix}`),
      await mkTestCase(request, `e2e-lb-tcA-2-${suffix}`),
    ];
    if (tcA.some(id => !id)) return;
    testCaseIds.push(...(tcA as string[]));

    // Agent A: 3/3 passed (100.0%). Agent B: 2/3 (66.7%). Agent C: 1/3 (33.3%).
    const plan: Array<{ agentKey: string; runId: string; verdicts: Array<'passed' | 'failed'> }> = [
      { agentKey: agentA, runId: runAId, verdicts: ['passed', 'passed', 'passed'] },
      { agentKey: agentB, runId: runBId, verdicts: ['passed', 'passed', 'failed'] },
      { agentKey: agentC, runId: runCId, verdicts: ['passed', 'failed', 'failed'] },
    ];

    const runsForBenchA: Record<string, unknown>[] = [];
    for (const { agentKey, runId, verdicts } of plan) {
      const results: Record<string, unknown> = {};
      for (let i = 0; i < verdicts.length; i++) {
        const reportId = await mkReport(request, agentKey, tcA[i] as string, verdicts[i]);
        if (!reportId) return;
        reportIds.push(reportId);
        results[tcA[i] as string] = { reportId, status: 'completed', passFailStatus: verdicts[i] };
      }
      const passed = verdicts.filter(v => v === 'passed').length;
      runsForBenchA.push({
        id: runId,
        name: `${agentKey} run`,
        agentKey,
        modelId: 'demo-model',
        createdAt: FAR_FUTURE,
        status: 'completed',
        benchmarkVersion: 1,
        testCaseSnapshots: [],
        results,
        stats: { passed, failed: verdicts.length - passed, pending: 0, errored: 0, total: verdicts.length },
      });
    }

    const benchARes = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchAName,
        description: 'needs-improvement leaderboard e2e — bench A (disposable)',
        testCaseIds: tcA,
        runs: runsForBenchA,
        currentVersion: 1,
        versions: [{ version: 1, createdAt: FAR_FUTURE, testCaseIds: tcA }],
      },
    });
    if (!benchARes.ok()) return;
    benchAId = (await benchARes.json()).id;

    // Bench B: single agent D, 1/2 (50.0%), own test cases, dated well
    // before Bench A so Bench A remains the "most recent" default.
    const tcD1 = await mkTestCase(request, `e2e-lb-tcD-0-${suffix}`);
    const tcD2 = await mkTestCase(request, `e2e-lb-tcD-1-${suffix}`);
    if (!tcD1 || !tcD2) return;
    testCaseIds.push(tcD1, tcD2);

    const repD1 = await mkReport(request, agentD, tcD1, 'passed');
    const repD2 = await mkReport(request, agentD, tcD2, 'failed');
    if (!repD1 || !repD2) return;
    reportIds.push(repD1, repD2);

    const benchBRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchBName,
        description: 'needs-improvement leaderboard e2e — bench B (disposable)',
        testCaseIds: [tcD1, tcD2],
        runs: [{
          id: runDId,
          name: `${agentD} run`,
          agentKey: agentD,
          modelId: 'demo-model',
          createdAt: FAR_PAST,
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            [tcD1]: { reportId: repD1, status: 'completed', passFailStatus: 'passed' },
            [tcD2]: { reportId: repD2, status: 'completed', passFailStatus: 'failed' },
          },
          stats: { passed: 1, failed: 1, pending: 0, errored: 0, total: 2 },
        }],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: FAR_PAST, testCaseIds: [tcD1, tcD2] }],
      },
    });
    if (!benchBRes.ok()) return;
    benchBId = (await benchBRes.json()).id;

    seeded = true;
  });

  test.afterAll(async ({ request }) => {
    if (benchAId) await request.delete(`/api/storage/benchmarks/${benchAId}`).catch(() => {});
    if (benchBId) await request.delete(`/api/storage/benchmarks/${benchBId}`).catch(() => {});
    for (const id of reportIds) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of testCaseIds) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  test('ranks agents by pass rate, defaults to the most-recent benchmark, and updates on switch', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmarks/runs/reports (storage not configured?)');

    await page.goto('/');
    await expect(page.locator('[data-testid="needs-improvement-card"]')).toBeVisible({ timeout: 30000 });

    // "By benchmark" is the widget's default tab — its table should already
    // be visible without clicking any tab.
    const table = page.locator('[data-testid="benchmark-leaderboard-table"]');
    await expect(table).toBeVisible({ timeout: 20000 });

    // Default selection is the most-recently-run benchmark (Bench A, 2099).
    const select = page.locator('[data-testid="benchmark-leaderboard-select"]');
    await expect(select).toContainText(benchAName, { timeout: 20000 });

    const rows = page.locator('[data-testid="benchmark-leaderboard-row"]');
    await expect(rows).toHaveCount(3);

    // Ranked by pass rate desc: A (100.0%) > B (66.7%) > C (33.3%).
    await expect(rows.nth(0)).toContainText(agentA);
    await expect(rows.nth(0)).toContainText('3/3');
    await expect(rows.nth(0)).toContainText('100.0%');

    await expect(rows.nth(1)).toContainText(agentB);
    await expect(rows.nth(1)).toContainText('2/3');
    await expect(rows.nth(1)).toContainText('66.7%');

    await expect(rows.nth(2)).toContainText(agentC);
    await expect(rows.nth(2)).toContainText('1/3');
    await expect(rows.nth(2)).toContainText('33.3%');

    // Row click navigates to that run's detail page.
    await rows.nth(0).click();
    await page.waitForURL(new RegExp(`/evaluations/benchmarks/${benchAId}/runs/${runAId}`), { timeout: 15000 });

    // Back to the dashboard (fresh load — local widget state, e.g. the
    // selector override, is expected to reset on remount).
    await page.goto('/');
    await expect(table).toBeVisible({ timeout: 20000 });

    // Switching the benchmark updates the table.
    await page.click('[data-testid="benchmark-leaderboard-select"]');
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
    await page.locator(`[role="option"]:has-text("${benchBName}")`).click();

    await expect(rows).toHaveCount(1, { timeout: 10000 });
    await expect(rows.nth(0)).toContainText(agentD);
    await expect(rows.nth(0)).toContainText('1/2');
    await expect(rows.nth(0)).toContainText('50.0%');
  });
});
