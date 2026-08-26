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

// Second suite: a benchmark that DOES have runs, so the escape-hatch UI
// ("Show all versions" button + "X of Y runs match vN" message) and the
// annotated version dropdown ((latest) / no-runs / N-runs labels) actually
// render — the zero-runs benchmark above always takes the plain "No runs
// yet" branch and never exercises these lines.
test.describe('Benchmark runs version filter — with runs present', () => {
  const bmName = `version-filter-runs-e2e-${Date.now()}`;
  let benchmarkId: string;
  let testCaseId: string;
  let testCaseId2: string;
  let runId: string;

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

    // Create v1, then bump to v2 by changing the test-case list (PUT with a
    // different testCaseIds list creates a new version per the server route
    // logic) so this benchmark has 2 versions — required for hasMultipleVersions
    // (the version dropdown is hidden entirely on single-version benchmarks).
    const bm = await request.post('/api/storage/benchmarks', {
      data: { name: bmName, description: 'e2e: version filter with runs', testCaseIds: [testCaseId] },
    });
    expect(bm.ok()).toBeTruthy();
    benchmarkId = (await bm.json()).id;

    const tc2 = await request.post('/api/storage/test-cases', {
      data: {
        name: `${bmName}-tc2`,
        category: 'Diagnostics',
        difficulty: 'Easy',
        initialPrompt: 'Say hello again',
        expectedOutcomes: ['Agent responds'],
        labels: [],
      },
    });
    expect(tc2.ok()).toBeTruthy();
    testCaseId2 = (await tc2.json()).id;

    const bumpVersion = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: { name: bmName, testCaseIds: [testCaseId, testCaseId2] },
    });
    expect(bumpVersion.ok()).toBeTruthy();

    // Seed ONE completed run on v1 (the OLD version, not the current v2).
    runId = `run-version-filter-e2e-${Date.now()}`;
    const putRuns = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bmName,
        runs: [{
          id: runId,
          name: 'E2E v1 Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: { [testCaseId]: { reportId: `report-${runId}`, status: 'completed' } },
          stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
        }],
      },
    });
    expect(putRuns.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
    if (testCaseId2) await request.delete(`/api/storage/test-cases/${testCaseId2}`).catch(() => {});
  });

  test('a VALID version filter with zero matching runs shows the escape hatch, not a bogus data-loss empty state', async ({ page }) => {
    // Persist a filter for v2 (a real, current version — not a stale/invalid
    // one) BEFORE the app loads. The only run is on v1, so this must NOT
    // self-heal to 'all' (v2 is a legitimate version); it must instead render
    // the "0 of N runs match v2" escape-hatch empty state.
    await page.addInitScript((id: string) => {
      try { localStorage.setItem(`agent-health:benchmark-runs:runVersionFilter:${id}`, '2'); } catch { /* sandboxed storage */ }
    }, benchmarkId);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await expect(page.getByRole('heading', { name: bmName })).toBeVisible({ timeout: 30000 });

    // Escape-hatch copy, not the plain "No runs yet" (that would mean the fix
    // regressed to treating a real-but-empty version filter as global emptiness).
    await expect(page.getByText(/0 of 1 run match v2/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Runs exist on other versions of this benchmark')).toBeVisible();

    const showAllBtn = page.getByTestId('show-all-versions-btn');
    await expect(showAllBtn).toBeVisible();
    await expect(showAllBtn).toHaveText('Show all versions (1)');

    // Clicking it resets the filter to 'all' and the v1 run becomes visible.
    await showAllBtn.click();
    await expect(page.getByText('E2E v1 Run')).toBeVisible({ timeout: 15000 });
    await expect(showAllBtn).toHaveCount(0);
  });

  test('an INVALID stale version filter self-heals to \'all\' and shows the existing run, not an empty state', async ({ page }) => {
    // v99 doesn't exist on this benchmark at all (unlike v2 above, which is a
    // real version with zero runs) — effectiveRunVersionFilter must treat this
    // as 'all', and the repair effect must persist the healed value.
    await page.addInitScript((id: string) => {
      try { localStorage.setItem(`agent-health:benchmark-runs:runVersionFilter:${id}`, '99'); } catch { /* sandboxed storage */ }
    }, benchmarkId);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await expect(page.getByRole('heading', { name: bmName })).toBeVisible({ timeout: 30000 });

    // Self-healed to 'all': the v1 run renders directly, no empty state at all.
    await expect(page.getByText('E2E v1 Run')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/No runs for v99/)).toHaveCount(0);
    await expect(page.getByTestId('show-all-versions-btn')).toHaveCount(0);

    // The repair effect wrote the healed 'all' back to storage (not just
    // masked it at render time) — reload and confirm it stuck.
    await page.reload();
    await expect(page.getByText('E2E v1 Run')).toBeVisible({ timeout: 15000 });
    const healed = await page.evaluate((id: string) => localStorage.getItem(`agent-health:benchmark-runs:runVersionFilter:${id}`), benchmarkId);
    expect(healed).toBe(JSON.stringify('all'));
  });

  test('the version dropdown annotates each entry with (latest) and its run count', async ({ page }) => {
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await expect(page.getByRole('heading', { name: bmName })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('E2E v1 Run')).toBeVisible({ timeout: 15000 });

    // Open the runs-version filter combobox (first combobox on the page that
    // shows "All Versions (…)" — there's no dedicated data-testid on the
    // trigger itself, only on its content).
    const versionCombobox = page.getByRole('combobox').filter({ hasText: /All Versions/ });
    await expect(versionCombobox).toBeVisible({ timeout: 15000 });
    await versionCombobox.click();

    // v2 is the latest version and has 0 runs; v1 is not latest and has 1 run.
    await expect(page.getByRole('option', { name: 'v2 (latest) · no runs' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'v1 · 1 run' })).toBeVisible();
  });
});
