/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * e2e: the Agent Traces UI renders spans returned in the normalized plain-raw
 * shape that the #296 fix produces (nested `attributes` with literal dotted OTel
 * keys, run-id correlation under `agent_health.run.id`). The server-side query
 * regression itself is covered by the integration test
 * (tests/integration/services/traces/plainRawCorrelation.integration.test.ts);
 * this guards the consumer -> UI contract for the schema without needing a live
 * OpenSearch cluster, by stubbing /api/traces at the network boundary.
 */

import { test, expect } from './fixtures/test-fixtures';

// One root + two children, in the shape /api/traces returns after transformSpan
// (attributes already normalized to dotted keys).
const PLAIN_RAW_SPANS = [
  {
    traceId: 'trace-e2e-AAA', spanId: 'root-A', parentSpanId: '',
    name: 'invoke_agent Strands Agent', startTime: '2026-06-17T09:00:00.000Z',
    endTime: '2026-06-17T09:00:03.000Z', duration: 3000, status: 'OK',
    attributes: {
      'agent_health.run.id': 'run-e2e-1', 'gen_ai.agent.name': 'retail-agent',
      serviceName: 'retail-agent', spanKind: 'SERVER',
    },
    events: [],
  },
  {
    traceId: 'trace-e2e-AAA', spanId: 'llm-A', parentSpanId: 'root-A',
    name: 'chat us.amazon.nova-pro-v1:0', startTime: '2026-06-17T09:00:00.500Z',
    endTime: '2026-06-17T09:00:01.500Z', duration: 1000, status: 'OK',
    attributes: {
      'agent_health.run.id': 'run-e2e-1', 'gen_ai.request.model': 'us.amazon.nova-pro-v1:0',
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300,
      serviceName: 'retail-agent', spanKind: 'CLIENT',
    },
    events: [],
  },
  {
    traceId: 'trace-e2e-AAA', spanId: 'tool-A', parentSpanId: 'root-A',
    name: 'execute_tool search_products', startTime: '2026-06-17T09:00:01.600Z',
    endTime: '2026-06-17T09:00:02.600Z', duration: 1000, status: 'OK',
    attributes: {
      'agent_health.run.id': 'run-e2e-1', 'gen_ai.tool.name': 'search_products',
      serviceName: 'retail-agent', spanKind: 'INTERNAL',
    },
    events: [],
  },
];

test.describe('Agent Traces — plain-raw schema rendering (#296)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/traces**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: PLAIN_RAW_SPANS, total: PLAIN_RAW_SPANS.length, hasMore: false, nextCursor: null }),
      });
    });
    await page.route('**/api/traces/health**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', backend: 'opensearch' }) });
    });
  });

  test('renders spans whose attributes come from the plain-raw nested shape', async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // The root agent span name (derived from a plain-raw doc) should surface in
    // the UI. If the consumer ignored the plain-raw attributes/spans, the page
    // would show only an empty state.
    const body = await page.locator('body').textContent();
    expect(body).toContain('invoke_agent Strands Agent');
  });

  test('issues a correlation request to /api/traces', async ({ page }) => {
    let called = false;
    await page.route('**/api/traces', async (route) => {
      called = true;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ spans: PLAIN_RAW_SPANS, total: PLAIN_RAW_SPANS.length }),
      });
    });
    await page.goto('/agent-traces');
    await page.waitForTimeout(2500);
    expect(called).toBe(true);
  });
});
