/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * N-run comparison deep-dive (2–4 runs).
 *
 * Regression guards for the exactly-2-runs gate removal:
 *   1. With THREE runs selected, the "What's actually different" panel renders
 *      (pre-change it was gated to exactly 2 runs and silently disappeared).
 *   2. The POST /api/comparison/deep-dive body carries one representative
 *      reportId per run (3 of them) PLUS the shared-case verdict matrix the
 *      server compresses into the deterministic prompt prefix.
 *   3. Run keys A/B/C render in the panel header, and a span citation from the
 *      THIRD run (C) is tagged with C's runId — i.e. citations aren't
 *      hardwired to a two-run A/B mapping.
 *
 * Deterministic: storage + /api/comparison/deep-dive are mocked via
 * page.route(); no model or trace cluster involved.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route, Page } from '@playwright/test';

const RUN_IDS = ['eval-run-n1', 'eval-run-n2', 'eval-run-n3'];
const AGENTS = ['alpha', 'bravo', 'charlie'];
const TCS = ['tc-n-1', 'tc-n-2'];
// reportIds: rep-<agent>-<tc index>
const rep = (agent: string, tcIdx: number) => `rep-${agent}-${tcIdx}`;
const RUNID_C = 'subprocess-nC';
const CITED_SPAN_C = 'cccc0000cccc0000';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-02-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: TCS }], trigger: 'cli',
  testCaseSnapshots: [
    { id: TCS[0], version: 1, name: 'qst_0001 [basic] Shared case one' },
    { id: TCS[1], version: 1, name: 'qst_0002 [semantic] Shared case two' },
  ],
  results: {
    [TCS[0]]: { reportId: rep(agent, 0), status: 'completed' },
    [TCS[1]]: { reportId: rep(agent, 1), status: 'completed' },
  },
  stats: { passed: 2, failed: 0, total: 2 },
});

const report = (agent: string, tcIdx: number, passed: boolean) => ({
  id: rep(agent, tcIdx), createdAt: '2026-02-01T10:00:00Z', testCaseId: TCS[tcIdx], agentId: agent,
  runId: `subprocess-${agent}-${tcIdx}`, modelId: 'claude-opus-4-8', status: 'completed',
  passFailStatus: passed ? 'passed' : 'failed',
  metrics: { accuracy: passed ? 100 : 0 }, trajectory: [],
  performanceMetrics: { durationMs: 40000 + tcIdx * 1000 },
});

// tc-n-1: all pass. tc-n-2: split (charlie fails).
const allReports = AGENTS.flatMap((agent, ai) => [
  report(agent, 0, true),
  report(agent, 1, ai !== 2),
]);

const deepDiveBody = {
  markdown:
    '**Headline**: A and B agree; C diverges on the split case.\n\n' +
    `- **Split case** — C failed where A/B passed [C retry loop](span:${RUNID_C}:${CITED_SPAN_C}).\n` +
    '- **Errors** — A: no errors observed. B: no errors observed. C: one failed tool call.\n',
  modelId: 'amazon-bedrock/claude-opus-4-8',
  durationMs: 5000,
  runs: [
    { key: 'A', reportId: rep('alpha', 0), runId: 'subprocess-alpha-0', serviceName: 'alpha-agent', startedAt: 1, endedAt: 2, testCaseId: TCS[0] },
    { key: 'B', reportId: rep('bravo', 0), runId: 'subprocess-bravo-0', serviceName: 'bravo-agent', startedAt: 1, endedAt: 2, testCaseId: TCS[0] },
    { key: 'C', reportId: rep('charlie', 0), runId: RUNID_C, serviceName: 'charlie-agent', startedAt: 1, endedAt: 2, testCaseId: TCS[0] },
    // Focus-case drill-down scope for the split case on run C.
    { key: 'C', reportId: rep('charlie', 1), runId: 'subprocess-charlie-1', serviceName: 'charlie-agent', startedAt: 1, endedAt: 2, testCaseId: TCS[1] },
  ],
};

async function setupRoutes(page: Page, onDeepDiveBody: (body: any) => void) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: RUN_IDS.map((rid, i) => evalRun(rid, AGENTS[i])), total: 3 });
    const idx = RUN_IDS.indexOf(id);
    if (idx >= 0) return json(r, evalRun(id, AGENTS[idx]));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs = allReports.filter((rep_) => ids.includes(rep_.id));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    const found = allReports.find((rep_) => u.includes(rep_.id));
    if (found) return json(r, found);
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => {
    onDeepDiveBody(JSON.parse(r.request().postData() || '{}'));
    return json(r, deepDiveBody);
  });
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

test.describe('Comparison deep-dive — N runs (3-run comparison)', () => {
  test('renders for 3 runs and sends 3 reportIds + the shared-case matrix', async ({ page }) => {
    let deepDiveRequest: any = null;
    await setupRoutes(page, (b) => { deepDiveRequest = b; });

    await page.goto(`/compare?runs=${RUN_IDS.join(',')}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // 1. The panel renders with 3 runs (pre-change: gated to exactly 2).
    const panel = page.locator('[data-testid="comparison-deep-dive"]');
    await expect(panel).toBeVisible({ timeout: 20000 });

    // 3. Header shows all three run-key badges and the deep-dive markdown.
    await expect(panel).toContainText('A');
    await expect(panel).toContainText('C');
    await expect(panel).toContainText('grounded in all 3 runs');
    await expect(panel).toContainText('C diverges on the split case');

    // The span citation from run C carries C's runId (not a 2-run A/B mapping).
    const citation = panel.locator(`button[data-span-id="${CITED_SPAN_C}"]`);
    await expect(citation).toBeVisible({ timeout: 20000 });
    await expect(citation).toHaveAttribute('data-run-id', RUNID_C);
    await expect(citation).toContainText('C·');

    // 2. The request carried one representative reportId per run + case matrix.
    expect(deepDiveRequest).not.toBeNull();
    expect(deepDiveRequest.reportIds).toEqual([rep('alpha', 0), rep('bravo', 0), rep('charlie', 0)]);
    expect(Array.isArray(deepDiveRequest.cases)).toBe(true);
    expect(deepDiveRequest.cases).toHaveLength(2);
    const split = deepDiveRequest.cases.find((c: any) => c.id === TCS[1]);
    expect(split.verdicts).toEqual(['pass', 'pass', 'fail']);
    expect(split.reportIds).toEqual([rep('alpha', 1), rep('bravo', 1), rep('charlie', 1)]);
  });
});
