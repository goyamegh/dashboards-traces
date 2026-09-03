/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for PR #447 review feedback: "scrolling doesn't work.
 * Hope its infinite scrolling." on the Cases tab for large benchmarks.
 *
 * The Cases tab used to render every filtered case row unconditionally,
 * which on a several-hundred-case benchmark makes the master list heavy and
 * (per the review comment) effectively unusable to scroll through. The fix
 * renders a bounded window (60 rows) and grows it via an IntersectionObserver
 * sentinel as the user scrolls — real infinite scroll, not a full render.
 *
 * This spec seeds a benchmark that exceeds the initial window, drives a real
 * scroll gesture against the actual scroll container (not a synthetic event),
 * and asserts the DOM grows incrementally and the container is genuinely
 * scrollable end to end.
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Cases tab — scrolling on large benchmarks (PR #447)', () => {
  test('renders cases incrementally and reveals more cases as the list is scrolled', async ({ page, request, testData }) => {
    const CASE_COUNT = 90; // exceeds the 60-case initial render window

    const testCases = Array.from({ length: CASE_COUNT }, (_, index) => ({
      name: uniqueTestName(`cases-scroll-${index}`),
      description: 'Cases-tab scrolling regression fixture (PR #447)',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: `Investigate scenario ${index}`,
      context: [],
      expectedOutcomes: ['n/a'],
    }));

    const bulkRes = await request.post('/api/storage/test-cases/bulk', { data: { testCases } });
    expect(bulkRes.ok()).toBeTruthy();
    const bulkBody = await bulkRes.json();
    const createdIds: string[] = (bulkBody.testCases || []).map((tc: any) => tc.id);
    expect(createdIds).toHaveLength(CASE_COUNT);
    testData.testCases(createdIds);

    const benchmarkRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('cases-scroll-benchmark'),
        description: 'Cases-tab scrolling regression fixture (PR #447)',
        testCaseIds: createdIds,
      },
    });
    expect(benchmarkRes.ok()).toBeTruthy();
    const benchmark = await benchmarkRes.json();
    const benchmarkId: string = benchmark.id || benchmark.benchmark?.id;
    expect(benchmarkId).toBeTruthy();
    testData.benchmark(benchmarkId);

    await page.goto(`/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}`);
    await page.waitForSelector('[data-testid="benchmark-cases-tab"]', { timeout: 30000 });

    const list = page.locator('[role="listbox"][aria-label="Benchmark cases"]');
    await expect(list).toBeVisible();

    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible({ timeout: 15000 });
    const initialCount = await options.count();
    expect(initialCount).toBe(60);
    await expect(page.getByTestId('case-list-load-more-sentinel')).toBeVisible();

    // A real scroll against the actual container — proves the list is
    // genuinely scrollable, not just structurally present with a stuck
    // scrollbar (the exact failure mode the review comment described).
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => options.count(), { timeout: 10000 }).toBeGreaterThan(initialCount);

    // Keep scrolling to the bottom until every case has loaded.
    await expect.poll(async () => {
      await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
      return options.count();
    }, { timeout: 20000 }).toBe(CASE_COUNT);

    await expect(page.getByTestId('case-list-load-more-sentinel')).toHaveCount(0);
  });
});
