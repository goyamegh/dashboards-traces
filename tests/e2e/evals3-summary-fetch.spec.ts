/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression for issue #591 — the Evaluations pages must never download
 * the full test-case corpus.
 *
 * `/evaluations/benchmarks` used to fetch EVERY test case in full
 * (`asyncTestCaseStorage.getAll()` without `summary`) into a map nobody read,
 * and its loading state waited on that request. On a cluster where a few
 * hundred cases carry a ~400 KB `sourceCode` that is a 200+ MB response —
 * ~18 s locally, minutes over a slow link — so the benchmark list "never
 * opened". `/evaluations/test-cases` and `/evaluations/runs/new` fetched the
 * same full payload for lists that render only name / description / labels.
 *
 * Real-shaped fixture: a benchmark plus three test cases, one carrying a
 * ~400 KB `sourceCode`, all seeded through the real API and deleted by id via
 * the `testData` fixture. The slow link is simulated by HOLDING any
 * non-summary `GET /api/storage/test-cases` for longer than the render
 * deadline — exactly how the bug presented — rather than by a fast fixture
 * that would hide it.
 */

import { test, expect, Page } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

const SOURCE_CODE_BYTES = 400_000;
/** How long a non-summary full fetch is held — longer than RENDER_DEADLINE_MS. */
const FULL_FETCH_HOLD_MS = 20_000;
/** The seeded rows must render within this, i.e. without waiting on a full fetch. */
const RENDER_DEADLINE_MS = 10_000;

const TEST_CASES_LIST_RE = /\/api\/storage\/test-cases(\?[^#]*)?$/;
const BENCHMARKS_LIST_RE = /\/api\/storage\/benchmarks(\?[^#]*)?$/;
/** Bundled demo data the "Show sample data" toggle reveals (cli/demo/sample*.ts). */
const SAMPLE_TEST_CASE_NAME = 'Weekend Getaway to Napa Valley';
const SAMPLE_BENCHMARK_NAME = 'Travel Planning Accuracy - Demo';

function isFullTestCaseListUrl(url: string): boolean {
  if (!TEST_CASES_LIST_RE.test(url)) return false;
  const u = new URL(url);
  return u.searchParams.get('fields') !== 'summary';
}

function syntheticSourceCode(seed: string): string {
  const line = `test('${seed}', { prompt: 'synthetic prompt' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
  return line.repeat(Math.ceil(SOURCE_CODE_BYTES / line.length)).slice(0, SOURCE_CODE_BYTES);
}

/**
 * Record every test-case list GET the page issues and hold the ones that
 * ask for the full payload, so a regression shows up as the list failing to
 * render in time AND as a recorded offending URL (two independent signals).
 */
async function recordTestCaseListRequests(page: Page): Promise<{ all: string[]; full: string[] }> {
  const all: string[] = [];
  const full: string[] = [];
  await page.route(TEST_CASES_LIST_RE, async (route) => {
    const url = route.request().url();
    if (route.request().method() !== 'GET') return route.continue();
    all.push(url);
    if (isFullTestCaseListUrl(url)) {
      full.push(url);
      await new Promise(r => setTimeout(r, FULL_FETCH_HOLD_MS));
    }
    // The page may already be closed once a held request is released.
    return route.continue().catch(() => {});
  });
  return { all, full };
}

test.describe('Evaluations pages never fetch the full test-case corpus (#591)', () => {
  let benchmarkName: string;
  let largeCaseName: string;
  let smallCaseNames: string[];

  test.beforeEach(async ({ request, testData }) => {
    benchmarkName = uniqueTestName('evals3-summary-bm');
    largeCaseName = uniqueTestName('evals3-summary-large');
    smallCaseNames = [uniqueTestName('evals3-summary-small-a'), uniqueTestName('evals3-summary-small-b')];

    const largeCase = {
      name: largeCaseName,
      description: 'code-imported case with a large source file',
      category: 'RCA',
      difficulty: 'Medium',
      labels: ['category:RCA', 'difficulty:Medium'],
      initialPrompt: 'Investigate the synthetic incident. '.repeat(10),
      context: [{ description: 'runbook', value: 'https://runbooks.example.invalid/large' }],
      expectedOutcomes: ['Identifies the offending component'],
      // No `sourceFile`: that selects the code-import UPSERT path, which
      // itself scans the whole corpus (slow on a large cluster, and a
      // separate concern). The strict-create path stores `sourceCode` as-is,
      // which is the property this fixture exists for.
      sourceFileName: `${largeCaseName}.eval.js`,
      sourceLanguage: 'javascript',
      sourceHash: largeCaseName,
      sourceCode: syntheticSourceCode(largeCaseName),
    };
    const smallCases = smallCaseNames.map((name, i) => ({
      name,
      description: `small case ${i}`,
      category: 'RCA',
      difficulty: 'Easy',
      labels: ['category:RCA', 'difficulty:Easy'],
      initialPrompt: `Small synthetic prompt ${i}`,
      context: [],
      expectedOutcomes: ['Answers'],
    }));

    const bulk = await request.post('/api/storage/test-cases/bulk', { data: { testCases: [largeCase, ...smallCases] } });
    const bulkBody = await bulk.json();
    // Track before asserting so a failed seed still gets cleaned up.
    const ids: string[] = (bulkBody?.testCases ?? []).map((tc: any) => tc?.id).filter(Boolean);
    testData.testCases(ids);
    expect(bulk.ok(), `bulk seed status ${bulk.status()}: ${JSON.stringify(bulkBody).slice(0, 300)}`).toBeTruthy();
    expect(ids).toHaveLength(3);

    const bm = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchmarkName,
        description: 'seed for #591 regression',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: ids }],
        testCaseIds: ids,
        runs: [],
      },
    });
    const bmBody = await bm.json();
    testData.benchmark(bmBody?.id || bmBody?.benchmark?.id);
    expect(bm.ok(), `benchmark seed status ${bm.status()}`).toBeTruthy();
  });

  test('Benchmarks page renders its list without any GET /api/storage/test-cases lacking fields=summary', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    const t0 = Date.now();
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // The seeded benchmark row must appear without waiting on a (held) full
    // test-case download — this is the "page never opens" symptom.
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    const renderedAfterMs = Date.now() - t0;
    expect(renderedAfterMs).toBeLessThan(FULL_FETCH_HOLD_MS);

    // Let any stragglers be issued, then check the ledger.
    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/benchmarks:\n${recorded.full.join('\n')}`).toEqual([]);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }
  });

  test('Test Cases page lists the seeded cases from a summary fetch (no sourceCode on the wire)', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);
    const summaryBodies: any[] = [];
    page.on('response', async (res) => {
      const url = res.url();
      if (res.request().method() === 'GET' && TEST_CASES_LIST_RE.test(url) && !isFullTestCaseListUrl(url)) {
        summaryBodies.push(await res.json().catch(() => null));
      }
    });

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });

    // Flat view so every seeded row is a plain table row regardless of grouping.
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.isVisible().catch(() => false)) await flat.click();

    for (const name of [largeCaseName, ...smallCaseNames]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    }

    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/test-cases:\n${recorded.full.join('\n')}`).toEqual([]);
    expect(recorded.all.length).toBeGreaterThan(0);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }

    // The large case arrived as a summary: present, but without its 400 KB source.
    const seen = summaryBodies.flatMap(b => b?.testCases ?? []).find((tc: any) => tc?.name === largeCaseName);
    expect(seen, 'large case present in the summary listing').toBeTruthy();
    expect(seen.sourceCode).toBeUndefined();
    expect(seen.sourceFileName).toBe(`${largeCaseName}.eval.js`);
    expect(seen.context).toEqual([]);
    expect(seen.expectedOutcomes).toEqual([]);
    expect(seen.versions).toEqual([]);
  });

  test('New Run page offers the seeded cases in its picker from a summary fetch', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    await page.goto('/evaluations/runs/new');
    await expect(page.getByText('Specific Test Cases')).toBeVisible({ timeout: 30_000 });

    for (const name of [largeCaseName, ...smallCaseNames]) {
      await expect(page.locator('label').filter({ hasText: name })).toHaveCount(1, { timeout: RENDER_DEADLINE_MS });
    }

    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/runs/new:\n${recorded.full.join('\n')}`).toEqual([]);
    expect(recorded.all.length).toBeGreaterThan(0);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }
  });

  test('Test Cases page keeps the summary projection when sample data is toggled on and off', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });
    await expect(page.getByText(smallCaseNames[0], { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    // Real data exists, so the server leaves the bundled demo cases out by default.
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true })).toHaveCount(0);
    const initialFetches = recorded.all.length;
    expect(initialFetches).toBeGreaterThan(0);

    // Toggle ON: the refetch must ask for the demo cases explicitly AND stay a
    // summary fetch — this branch of the request used to be the easiest place
    // to reintroduce a full download.
    await page.getByRole('button', { name: 'Show sample data' }).click();
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => recorded.all.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(initialFetches);
    const withSample = recorded.all.slice(initialFetches);
    expect(withSample.length).toBeGreaterThan(0);
    for (const url of withSample) {
      const params = new URL(url).searchParams;
      expect(params.get('fields')).toBe('summary');
      expect(params.get('includeSample')).toBe('true');
    }
    // The seeded (real) rows are still listed alongside the demo ones.
    await expect(page.getByText(smallCaseNames[0], { exact: true }).first()).toBeVisible();

    // Toggle OFF: back to the server default (no includeSample), still summary.
    const beforeHide = recorded.all.length;
    await page.getByRole('button', { name: 'Hide sample data' }).click();
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true })).toHaveCount(0, { timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => recorded.all.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(beforeHide);
    for (const url of recorded.all.slice(beforeHide)) {
      const params = new URL(url).searchParams;
      expect(params.get('fields')).toBe('summary');
      expect(params.get('includeSample')).toBeNull();
    }

    expect(recorded.full, `full test-case fetches issued while toggling sample data:\n${recorded.full.join('\n')}`).toEqual([]);
  });

  test('Benchmarks page toggles sample data by refetching benchmarks only (no test-case download)', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);
    const benchmarkFetches: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && BENCHMARKS_LIST_RE.test(req.url())) benchmarkFetches.push(req.url());
    });

    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toHaveCount(0);
    const initialBenchmarkFetches = benchmarkFetches.length;
    expect(initialBenchmarkFetches).toBeGreaterThan(0);
    for (const url of benchmarkFetches) {
      expect(new URL(url).searchParams.get('includeSample')).toBeNull();
    }

    await page.getByRole('button', { name: 'Show sample data' }).click();
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => benchmarkFetches.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(initialBenchmarkFetches);
    for (const url of benchmarkFetches.slice(initialBenchmarkFetches)) {
      expect(new URL(url).searchParams.get('includeSample')).toBe('true');
    }
    // The seeded (real) benchmark is still listed alongside the demo one.
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Hide sample data' }).click();
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toHaveCount(0, { timeout: RENDER_DEADLINE_MS });

    // Throughout: the Benchmarks list never needs test cases, in any mode.
    await page.waitForTimeout(500);
    expect(recorded.all, `test-case list fetches issued by /evaluations/benchmarks while toggling sample data:\n${recorded.all.join('\n')}`).toEqual([]);
  });
});
