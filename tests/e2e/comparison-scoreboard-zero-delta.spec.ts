/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: ComparisonScoreboard's delta footer row rendered a bare '='
 * glyph when costDelta / durationDelta was exactly 0 (identical runs). A
 * bare '=' reads as a typo/equals-sign rather than "no change". Now renders
 * an em dash ("\u2014") with a "No change" tooltip, matching the muted
 * styling already used for the zero case.
 *
 * Seeds two evaluation runs with an IDENTICAL performanceMetrics.
 * avgTestCaseDurationMs (the fallback path calculateRunAggregates/
 * ComparisonPage use when no trace metrics are available) so durationDelta
 * is exactly 0 and deterministically reproducible without OpenSearch traces.
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_A = `eval-run-e2e-delta-aaaaaa-${Date.now()}`;
const RUN_B = `eval-run-e2e-delta-bbbbbb-${Date.now()}`;
const TC = `tc-e2e-delta-${Date.now()}`;
const SAME_DURATION_MS = 4242;

function evalRunDoc(id: string, name: string, agentKey: string) {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: { [TC]: { reportId: `report-${id}`, status: 'completed', passFailStatus: 'passed' } },
    stats: { passed: 1, failed: 0, total: 1 },
    performanceMetrics: {
      durationMs: SAME_DURATION_MS,
      concurrency: 1,
      avgTestCaseDurationMs: SAME_DURATION_MS,
      maxTestCaseDurationMs: SAME_DURATION_MS,
      minTestCaseDurationMs: SAME_DURATION_MS,
    },
  };
}

test.describe('Comparison scoreboard — no bare "=" glyph for zero delta', () => {
  test('identical-duration runs render an em dash with a "No change" tooltip, not "="', async ({ page }) => {
    const api = page.request;
    try {
      const a = await api.put(`/api/storage/evaluation-runs/${RUN_A}`, { data: evalRunDoc(RUN_A, 'E2E Delta Run A', 'agent-alpha') });
      const b = await api.put(`/api/storage/evaluation-runs/${RUN_B}`, { data: evalRunDoc(RUN_B, 'E2E Delta Run B', 'agent-beta') });
      expect(a.ok()).toBeTruthy();
      expect(b.ok()).toBeTruthy();

      await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
      await page.waitForTimeout(2000);

      const durationCell = page.locator('[data-testid="scoreboard-delta-duration"]');
      await expect(durationCell).toBeVisible();
      await expect(durationCell).toHaveText('\u2014');
      await expect(durationCell).not.toHaveText('=');
      await expect(durationCell).toHaveAttribute('title', 'No change');
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_A}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_B}`).catch(() => {});
    }
  });
});
