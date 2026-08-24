/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison deep-dive — "on-the-fly" chart + suggested-experiments sections.
 *
 * The deep-dive agent can now record (via record_metric_chart /
 * record_experiment_suggestions tool calls, tested at the unit level in
 * comparisonTraceTools.test.ts) a small A-vs-B chart and a list of concrete
 * follow-up experiment ideas alongside its markdown narrative. This spec
 * asserts the UI actually RENDERS both sections when the API returns them,
 * and renders NEITHER when the API omits them (older/degenerate responses).
 *
 * Deterministic: storage, /api/comparison/deep-dive and /api/traces are all
 * mocked via page.route() — no LLM/AWS creds required.
 */

import { test, expect, Route } from '@playwright/test';

const RUN_A = 'eval-run-chartA';
const RUN_B = 'eval-run-chartB';
const TC = 'tc-chart-experiments';
const RUNID_A = 'subprocess-chartA';
const RUNID_B = 'subprocess-chartB';
const TRACE_A = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const TRACE_B = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
const CITED_SPAN_A = TRACE_A + '-tool';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string, repId: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-03-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC] }], trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Shared Case' }],
  results: { [TC]: { reportId: repId, status: 'completed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});
const report = (id: string, agent: string, runId: string, traceId: string) => ({
  id, createdAt: '2026-03-01T10:00:00Z', testCaseId: TC, agentId: agent,
  runId, modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
  traceId, metrics: { accuracy: 100 }, trajectory: [],
});
const span = (traceId: string, spanId: string, name: string) => ({
  traceId, spanId, name, startTime: '2026-03-01T10:00:00.000Z', endTime: '2026-03-01T10:00:01.000Z',
  durationMs: 1000, serviceName: 'demo-agent', kind: 'SPAN_KIND_SERVER',
  attributes: { 'service.name': 'demo-agent' }, status: 'OK',
});

const deepDiveBodyWithExtras = {
  markdown: `**Both resolved it correctly — A was more thorough**\n\n- **Tool economy**: A made more tool calls than B.\n- **Errors**: no errors observed in run A; no errors observed in run B.\n`,
  modelId: 'amazon-bedrock/claude-opus-4-8',
  durationMs: 4200,
  chart: {
    title: 'Tool usage & retries',
    series: [
      { label: 'Tool calls', a: 12, b: 5 },
      { label: 'Retries', a: 3, b: 0, unit: 'calls' },
      { label: 'Duration', a: 211, b: 88, unit: 's' },
    ],
  },
  experiments: [
    {
      title: 'Force a mid-task tool failure',
      rationale: `A recovered from a retried [tool call](span:${RUNID_A}:${CITED_SPAN_A}) B never hit.`,
    },
    {
      title: 'Add a second related ticket to the prompt',
      rationale: 'Neither run explored cross-ticket linkage — worth probing.',
    },
  ],
  runs: [
    { key: 'A', reportId: 'rep-chart-a', runId: RUNID_A, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
    { key: 'B', reportId: 'rep-chart-b', runId: RUNID_B, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
  ],
};

async function setupRoutes(page: import('@playwright/test').Page, deepDiveBody: unknown) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-chart-a'), evalRun(RUN_B, 'pulsar', 'rep-chart-b')], total: 2 });
    if (id === RUN_A) return json(r, evalRun(RUN_A, 'demo', 'rep-chart-a'));
    if (id === RUN_B) return json(r, evalRun(RUN_B, 'pulsar', 'rep-chart-b'));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-chart-a'))) runs.push(report('rep-chart-a', 'demo', RUNID_A, TRACE_A));
    if (ids.some((id) => id.includes('rep-chart-b'))) runs.push(report('rep-chart-b', 'pulsar', RUNID_B, TRACE_B));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    if (u.includes('rep-chart-a')) return json(r, report('rep-chart-a', 'demo', RUNID_A, TRACE_A));
    if (u.includes('rep-chart-b')) return json(r, report('rep-chart-b', 'pulsar', RUNID_B, TRACE_B));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => json(r, deepDiveBody));
  await page.route('**/api/traces', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const tid = body.traceId as string | undefined;
    const spans = tid === TRACE_A ? [span(TRACE_A, CITED_SPAN_A, 'execute_tool bash')] : tid === TRACE_B ? [] : [];
    return json(r, { backend: 'opensearch', spans, total: spans.length });
  });
}

test.describe('Comparison deep-dive — on-the-fly chart + suggested experiments', () => {
  test('renders the compare-bars chart and suggested-experiments section when the API returns them', async ({ page }) => {
    await setupRoutes(page, deepDiveBodyWithExtras);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // Chart: title + all three series labels + a couple of formatted values.
    const chart = page.locator('[data-testid="deep-dive-chart"]');
    await expect(chart).toBeVisible({ timeout: 20000 });
    await expect(chart).toContainText('Tool usage & retries');
    await expect(chart).toContainText('Tool calls');
    await expect(chart).toContainText('Retries');
    await expect(chart).toContainText('Duration');
    await expect(chart).toContainText('12');
    await expect(chart).toContainText('88 s');

    // Suggested experiments: heading + both suggestion titles + rationale text.
    const experiments = page.locator('[data-testid="deep-dive-experiments"]');
    await expect(experiments).toBeVisible();
    await expect(experiments).toContainText('Suggested next experiments');
    await expect(experiments).toContainText('Force a mid-task tool failure');
    await expect(experiments).toContainText('Add a second related ticket to the prompt');
    await expect(experiments).toContainText('Neither run explored cross-ticket linkage');

    // The span citation embedded in a suggestion's rationale still renders as
    // a clickable deep-link pill (reuses the same SpanAnchor as the narrative).
    const citation = experiments.locator(`button[data-span-id="${CITED_SPAN_A}"]`);
    await expect(citation).toBeVisible();
    await expect(citation).toHaveAttribute('data-run-id', RUNID_A);
  });

  test('renders neither section when the API response omits chart/experiments', async ({ page }) => {
    const { chart, experiments, ...bare } = deepDiveBodyWithExtras;
    await setupRoutes(page, bare);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="deep-dive-chart"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-experiments"]')).toHaveCount(0);
  });

  test('degrades gracefully (no crash, no NaN%/negative width) when a chart value is malformed', async ({ page }) => {
    // Simulates a value that survived JSON as `null` (e.g. a NaN a model tool
    // call produced got serialized to null) and a negative value that slipped
    // past the schema's `minimum: 0` — defense-in-depth on the RENDER side,
    // since chart values come from an LLM tool call that is never independently
    // re-validated against the spans it cited.
    const malformed = {
      ...deepDiveBodyWithExtras,
      chart: {
        title: 'Malformed values',
        series: [
          { label: 'Null value', a: null, b: 4 },
          { label: 'Negative value', a: -5, b: 3 },
        ],
      },
    };
    await setupRoutes(page, malformed);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const chart = page.locator('[data-testid="deep-dive-chart"]');
    await expect(chart).toBeVisible({ timeout: 20000 });
    // Null renders as an explicit dash rather than "NaN" or a crash.
    await expect(chart).toContainText('—');
    // Negative value is still shown as text (not silently dropped)…
    await expect(chart).toContainText('-5');
    // …but no bar element was given an invalid negative or NaN CSS width.
    const badWidths = await page.locator('[data-testid="deep-dive-chart"] [style*="width"]').evaluateAll((els) =>
      els
        .map((el) => (el as HTMLElement).style.width)
        .filter((w) => w.includes('NaN') || w.includes('-'))
    );
    expect(badWidths).toEqual([]);
  });
});
