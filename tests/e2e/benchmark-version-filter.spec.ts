// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * E2E regression: a stale persisted run-version filter must never render the
 * "No runs for vN" empty state on a benchmark that doesn't have that version.
 *
 * The bug: the filter was persisted under ONE global localStorage key
 * (`agent-health:benchmark-runs:runVersionFilter`), so v8 selected on one
 * benchmark leaked onto every other benchmark — including v1 benchmarks with
 * plenty of runs — making the runs panel look like data loss.
 *
 * The fix is two-layered (per-benchmark key + self-heal of impossible
 * versions), so this test seeds BOTH the legacy global key and a stale
 * per-benchmark key and asserts neither can produce "No runs for v8".
 */
import { test, expect } from './fixtures/test-fixtures';

test.describe('Benchmark runs version filter', () => {
  const bmName = `version-filter-e2e-${Date.now()}`;
  let benchmarkId: string;
  let testCaseId: string;

  test.beforeAll(async ({ request }) => {
    const tc = await request.post('/api/storage/test-cases', {
      data: {
        name: `${bmName}-tc`,
        category: 'Diagnostics',
        difficulty: 'Easy',
        initialPrompt: 'Say hello',
        expectedOutcomes: ['Agent responds'],
        labels: [],
      },
    });
    expect(tc.ok()).toBeTruthy();
    testCaseId = (await tc.json()).id;

    const bm = await request.post('/api/storage/benchmarks', {
      data: { name: bmName, description: 'e2e: stale version filter', testCaseIds: [testCaseId] },
    });
    expect(bm.ok()).toBeTruthy();
    benchmarkId = (await bm.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('stale persisted v8 filter self-heals instead of hiding all runs', async ({ page }) => {
    // Seed both the legacy global key and a stale per-benchmark key BEFORE
    // the app loads.
    await page.addInitScript((id: string) => {
      try {
        localStorage.setItem('agent-health:benchmark-runs:runVersionFilter', '8');
        localStorage.setItem(`agent-health:benchmark-runs:runVersionFilter:${id}`, '8');
      } catch { /* sandboxed storage */ }
    }, benchmarkId);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);

    // The benchmark header renders...
    await expect(page.getByRole('heading', { name: bmName })).toBeVisible({ timeout: 30000 });

    // ...and the bogus version-scoped empty state never appears. This
    // benchmark is v1 with zero runs, so the correct empty state is the
    // unfiltered "No runs yet" — NOT "No runs for v8".
    await expect(page.getByText(/No runs for v8/)).toHaveCount(0);
    await expect(page.getByText(/No runs yet/)).toBeVisible({ timeout: 15000 });
  });
});
