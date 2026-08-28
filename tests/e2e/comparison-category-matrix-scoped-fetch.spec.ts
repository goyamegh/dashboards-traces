/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the comparison page's category × run matrix
 * (ComparisonInsightsBand) needs each row's test-case NAME to extract the
 * "[category]" tag (lib/comparisonInsights.ts extractRowCategory). The name
 * lookup used to call `asyncTestCaseStorage.getAll()` \u2014 one unpaginated
 * `GET /api/storage/test-cases` request for EVERY test case in the whole
 * storage backend, full body included (sourceCode/context/expectedOutcomes),
 * regardless of how many test cases the current comparison actually needs.
 * On a real deployment (thousands of test cases, 100+ MB payload) that call
 * is slow enough \u2014 or fails outright over a slow link \u2014 that the lookup
 * (`allTestCases`) stayed empty, every row resolved to `(uncategorized)`,
 * and the category matrix never rendered even though the agreement chips
 * above it (which don't need names) rendered fine. Verified in production
 * 2026-08-27 comparing two EnterpriseRAG-84 runs.
 *
 * This spec seeds two runs sharing 150 test cases (comfortably over the
 * id-chunk threshold) across 3 categories, and asserts:
 *  1. The test-case name lookup is scoped to the ids the current comparison
 *     actually needs \u2014 never an unscoped `GET /api/storage/test-cases`
 *     with no `ids` filter.
 *  2. Every id it does request is one of the compared runs' test-case ids
 *     (no over-fetching beyond what's needed).
 *  3. The category matrix renders with the real categories despite the
 *     large id count.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route, Page } from '@playwright/test';

const RUN_A = 'eval-run-catmatrix-a';
const RUN_B = 'eval-run-catmatrix-b';
const CATEGORIES = ['basic', 'semantic', 'completeness'];
const TC_COUNT = 150; // >100 forces id-chunking on the (now scoped) lookup too
const TCS = Array.from({ length: TC_COUNT }, (_, i) => `tc-catmatrix-${i}`);
const categoryFor = (i: number) => CATEGORIES[i % CATEGORIES.length];
const nameFor = (i: number) => `q${i} [${categoryFor(i)}] case ${i}`;

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const repId = (run: string, tc: string) => `rep-${run}-${tc}`;

function evalRunDoc(id: string, agentKey: string, passFailByIndex: (i: number) => 'passed' | 'failed') {
  return {
    id,
    docType: 'evaluation-run',
    name: `Category Matrix Run ${agentKey}`,
    createdAt: '2026-08-27T10:00:00Z',
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [{ type: 'test-case-ids', ids: TCS }],
    trigger: 'cli',
    testCaseSnapshots: TCS.map((tc, i) => ({ id: tc, version: 1, name: nameFor(i) })),
    results: Object.fromEntries(
      TCS.map((tc, i) => [tc, { reportId: repId(id, tc), status: 'completed', passFailStatus: passFailByIndex(i) }])
    ),
    stats: { passed: TC_COUNT, failed: 0, total: TC_COUNT },
  };
}

function storageReport(reportId: string, testCaseId: string, agentId: string, passFailStatus: 'passed' | 'failed') {
  return {
    id: reportId,
    createdAt: '2026-08-27T10:00:00Z',
    testCaseId,
    agentId,
    modelId: 'e2e-model',
    status: 'completed',
    passFailStatus,
    metricsStatus: 'completed',
    metrics: { accuracy: passFailStatus === 'passed' ? 95 : 20 },
    trajectory: [],
    annotations: [],
  };
}

function storageTestCase(i: number) {
  const tc = TCS[i];
  return {
    id: tc,
    name: nameFor(i),
    description: 'e2e category-matrix',
    initialPrompt: 'q',
    expectedOutcomes: ['x'],
    labels: ['category:RAG'],
    version: 1,
    createdAt: '2026-08-27T10:00:00Z',
    updatedAt: '2026-08-27T10:00:00Z',
  };
}

const passFailA = (i: number): 'passed' | 'failed' => (i % 3 === 0 ? 'failed' : 'passed');
const passFailB = (i: number): 'passed' | 'failed' => (i % 4 === 0 ? 'failed' : 'passed');

let unscopedTestCasesFetch = false;
let requestedTestCaseIds: Set<string> = new Set();

async function setupCommon(page: Page) {
  unscopedTestCasesFetch = false;
  requestedTestCaseIds = new Set();

  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));

  // The lookup under test. A request with NO `ids` query param is the
  // pre-fix, unscoped `getAll()` shape — flag it (don't hang the test on
  // it; the assertion below is what actually catches the regression). A
  // scoped `?ids=...` request is answered with exactly those test cases.
  await page.route('**/api/storage/test-cases**', (r) => {
    const u = new URL(r.request().url());
    const idsParam = u.searchParams.get('ids');
    if (!idsParam) {
      unscopedTestCasesFetch = true;
      return json(r, { testCases: [], total: 0 });
    }
    const ids = idsParam.split(',').filter(Boolean);
    ids.forEach(id => requestedTestCaseIds.add(id));
    const testCases = ids
      .map(id => TCS.indexOf(id))
      .filter(i => i >= 0)
      .map(i => storageTestCase(i));
    return json(r, { testCases, total: testCases.length });
  });

  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const m = r.request().url().match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRunDoc(RUN_A, 'agent-a', passFailA), evalRunDoc(RUN_B, 'agent-b', passFailB)], total: 2 });
    if (id === RUN_A) return json(r, evalRunDoc(RUN_A, 'agent-a', passFailA));
    if (id === RUN_B) return json(r, evalRunDoc(RUN_B, 'agent-b', passFailB));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route(/\/api\/storage\/runs\?ids=/, async (r) => {
    const u = new URL(r.request().url());
    const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
    const runs = ids.map(id => {
      const isA = id.startsWith(`rep-${RUN_A}-`);
      const tc = id.replace(`rep-${isA ? RUN_A : RUN_B}-`, '');
      const idx = TCS.indexOf(tc);
      const pf = isA ? passFailA(idx) : passFailB(idx);
      return storageReport(id, tc, isA ? 'agent-a' : 'agent-b', pf);
    });
    return json(r, { runs, total: runs.length });
  });

  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

test.describe('Comparison page — category matrix name lookup is id-scoped', () => {
  test('never fetches the unscoped test-case corpus, and the matrix renders with real categories', async ({ page }) => {
    await setupCommon(page);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="comparison-insights-band"]', { timeout: 30000 });

    // The actual bug symptom: matrix must render, not just the agreement chips.
    const matrix = page.getByTestId('insights-category-matrix');
    await expect(matrix).toBeVisible({ timeout: 15000 });
    for (const cat of CATEGORIES) {
      await expect(matrix).toContainText(cat);
    }

    // Regression guard #1: never the unscoped getAll() shape.
    expect(unscopedTestCasesFetch).toBe(false);

    // Regression guard #2: only fetched ids the comparison actually needs
    // (no over-fetching beyond the two runs' shared test-case set).
    expect(requestedTestCaseIds.size).toBeGreaterThan(0);
    for (const id of requestedTestCaseIds) {
      expect(TCS).toContain(id);
    }
    // And nothing was missed — every compared test case got its name resolved.
    expect([...requestedTestCaseIds].sort()).toEqual([...TCS].sort());
  });
});
