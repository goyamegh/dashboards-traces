/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E spec for the Test Case detail page's Context section pretty-printing.
 *
 * Regression coverage for: a JSON context item rendered as a raw, truncated
 * one-liner (`{"appId":"explore","timeRange":{"from":"now-15m",...`) instead
 * of something a human can read (reported against the "Detect Error Codes"
 * test case on the live tunnel). Verifies through a real browser that:
 *   1. A JSON context item renders pretty-printed (multi-line, indented) and
 *      UNTRUNCATED, expanded by default — no click required to see it.
 *   2. A non-JSON context item renders its full text, also untruncated.
 *   3. Each item collapses independently (scoped fix — no page
 *      restructuring; that is opensearch-project/agent-health#428's lane).
 *
 * Uses the demo agent + demo-model so it needs no real observio endpoint or
 * Bedrock credentials. Creates its own test case + run via the storage API
 * and cleans up after itself.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

const TEST_TIMEOUT = 90_000; // demo agent + demo judge → ~5–8s per run

const JSON_CONTEXT_VALUE = JSON.stringify({
  appId: 'explore',
  timeRange: { from: 'now-15m', to: 'now' },
  filters: [{ field: 'status', value: 'error' }],
});

const PLAIN_CONTEXT_VALUE =
  'Alert fired: web-server-01 CPU utilization exceeded 90% for 5 consecutive minutes during the incident window under investigation.';

async function createTestCase(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/test-case-context-pretty.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: 'What is 2+2?',
      context: [
        { description: 'Query context', value: JSON_CONTEXT_VALUE },
        { description: 'Alert note', value: PLAIN_CONTEXT_VALUE },
      ],
      expectedOutcomes: ['Agent identifies the answer is 4'],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  const tc = await res.json();
  const id: string = tc.id;
  return {
    id,
    cleanup: async () => {
      // Delete every run on the test case first, then the test case itself,
      // so we don't leave orphan run docs in storage.
      const runsRes = await request.get(`/api/storage/runs/by-test-case/${encodeURIComponent(id)}`);
      if (runsRes.ok()) {
        const data = await runsRes.json();
        for (const r of data.runs || []) {
          if (typeof r.id === 'string' && r.id.startsWith('report-')) {
            await request.delete(`/api/storage/runs/${encodeURIComponent(r.id)}`).catch(() => {});
          }
        }
      }
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    },
  };
}

// A run must exist for the split-pane (left panel Definition/Context block)
// to render — the empty-state full-width view doesn't show context today
// (pre-existing gap, out of scope for this fix).
async function runEvaluation(request: APIRequestContext, testCaseId: string): Promise<string> {
  const res = await request.post('/api/evaluate', {
    data: { testCaseId, agentKey: 'demo', modelId: 'demo-model' },
  });
  expect(res.ok(), 'POST /api/evaluate').toBe(true);
  const text = await res.text();
  const completedLine = text
    .split('\n')
    .find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(completedLine, 'evaluation should produce a completed SSE event').toBeTruthy();
  const parsed = JSON.parse(completedLine!.slice('data: '.length));
  expect(parsed.reportId).toBeTruthy();
  return parsed.reportId;
}

test.describe('Test Case Detail — Context section pretty-printing', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) {
      test.skip(true, 'Backend storage not available');
    }
  });

  test('JSON context renders pretty-printed and expanded by default; non-JSON stays full text', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-context-pretty-${Date.now()}`);
    try {
      await runEvaluation(request, tc.id);

      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-context-pretty-');

      // Both context item titles are visible without any click.
      await expect(page.getByText('Query context')).toBeVisible();
      await expect(page.getByText('Alert note')).toBeVisible();

      // JSON item: pretty-printed (multi-line + indented), untruncated, and
      // expanded on arrival — this is the exact regression. The old code
      // rendered `{"appId":"explore","timeRange":{"from":"now-15m",...` as a
      // single truncated line via `ctx.value.slice(0, 100)`.
      const prettyBlock = page.getByTestId('context-value-pretty');
      await expect(prettyBlock).toHaveCount(1);
      await expect(prettyBlock).toBeVisible();
      const prettyText = await prettyBlock.textContent();
      expect(prettyText).toContain('"appId"');
      expect(prettyText).toContain('"now-15m"');
      expect(prettyText).toContain('"error"'); // nested filter value — proves no truncation
      expect(prettyText).not.toContain('…');
      expect((prettyText || '').split('\n').length).toBeGreaterThan(1); // actually multi-line

      // Non-JSON item: full text, no truncation, no ellipsis, no JSON badge.
      const plainBlock = page.getByTestId('context-value-plain');
      await expect(plainBlock).toHaveCount(1);
      await expect(plainBlock).toHaveText(PLAIN_CONTEXT_VALUE);

      // Each item collapses independently (scoped fix — no page
      // restructuring). The first toggle in DOM order belongs to the JSON
      // item (context items render in the order they were created above).
      await page.getByTestId('context-value-toggle').first().click();
      await expect(page.getByTestId('context-value-pretty')).toHaveCount(0);
      await expect(plainBlock).toBeVisible(); // the other item is untouched
    } finally {
      await tc.cleanup();
    }
  });
});
