/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the comparison page must (a) show a LOADING indicator while the
 * per-test-case reports are still loading — not render every cell as empty
 * "missing" — and (b) fetch all reports in ONE batched request, not N
 * individual /runs/:id round-trips.
 *
 * Root cause being guarded: buildTestCaseComparisonRows() yields {status:
 * 'missing'} for any cell whose report isn't loaded yet, so without a loading
 * state the whole table reads empty for the fetch window ("no runs on each
 * test case by default"). And 16 individual report fetches (some MBs of
 * rawEvents each) is the perceived slowness.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route, Page } from '@playwright/test';

const RUN_A = 'eval-run-ldA';
const RUN_B = 'eval-run-ldB';
const TCS = ['tc1', 'tc2', 'tc3'];

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const repId = (run: string, tc: string) => `rep-${run}-${tc}`;

const evalRun = (id: string, agent: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-06-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: TCS }], trigger: 'cli',
  testCaseSnapshots: TCS.map(tc => ({ id: tc, version: 1, name: `Case ${tc}` })),
  results: Object.fromEntries(TCS.map(tc => [tc, { reportId: repId(id, tc), status: 'completed' }])),
  stats: { passed: TCS.length, failed: 0, total: TCS.length },
});

// Storage-format report (toTestCaseRun maps it → app EvaluationReport).
const storageReport = (id: string, agent: string) => ({
  id, createdAt: '2026-06-01T10:00:00Z', testCaseId: id.split('-').slice(-1)[0],
  agentId: agent, modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
  metricsStatus: 'completed', metrics: { accuracy: 95, faithfulness: 90, trajectory_alignment_score: 88, latency_score: 80 },
  trajectory: [], annotations: [],
});

let batchCalls = 0;
let individualReportCalls = 0;

async function setup(page: Page, batchDelayMs: number) {
  batchCalls = 0; individualReportCalls = 0;
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const m = r.request().url().match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo'), evalRun(RUN_B, 'pulsar')], total: 2 });
    if (id === RUN_A) return json(r, evalRun(RUN_A, 'demo'));
    if (id === RUN_B) return json(r, evalRun(RUN_B, 'pulsar'));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  // The batched report fetch (one request, server fans out).
  await page.route(/\/api\/storage\/runs\?ids=/, async (r) => {
    batchCalls++;
    const u = new URL(r.request().url());
    const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (batchDelayMs) await new Promise(res => setTimeout(res, batchDelayMs));
    const runs = ids.map(id => storageReport(id, id.includes(RUN_A) ? 'demo' : 'pulsar'));
    return json(r, { runs, total: runs.length });
  });
  // Any per-report individual fetch is a regression (should be zero).
  await page.route(/\/api\/storage\/runs\/rep-/, (r) => { individualReportCalls++; return r.fulfill({ status: 404, body: '{}' }); });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

test.describe('Comparison page — report loading state + batched fetch', () => {
  test('shows loading skeletons while reports load, then resolves to cells', async ({ page }) => {
    await setup(page, 1500); // delay the batch so the loading state is observable
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    // While the batch is in flight, cells show a skeleton — NOT empty.
    await expect(page.locator('[data-testid="metric-cell-loading"]').first()).toBeVisible({ timeout: 10000 });
    // Once it resolves, skeletons disappear and real pass/fail cells render.
    await expect(page.locator('[data-testid="metric-cell-loading"]')).toHaveCount(0, { timeout: 8000 });
  });

  test('fetches all reports in ONE batch request, zero individual /runs/:id calls', async ({ page }) => {
    await setup(page, 0);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="metric-cell-loading"]')).toHaveCount(0, { timeout: 8000 });
    await page.waitForTimeout(500);
    expect(batchCalls).toBeGreaterThanOrEqual(1);
    expect(individualReportCalls).toBe(0);
  });
});
