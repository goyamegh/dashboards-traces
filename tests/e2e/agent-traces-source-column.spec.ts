/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Traces → every trace row (and the expanded trace header) identifies
 * the observability source it was read from: the configured source NAME and
 * its backend TYPE. With several sources the composite backend tags each span
 * (`agent_health.source`, `agent_health.source.type`); with a single backend
 * the API's `backend` field identifies it.
 */

import { test, expect } from './fixtures/test-fixtures';

const T0 = Date.now() - 5 * 60_000;
const span = (traceId: string, spanId: string, name: string, service: string, source?: { name: string; type: string }, offsetMs = 0) => ({
  traceId, spanId, name, startTime: new Date(T0 + offsetMs).toISOString(), endTime: new Date(T0 + offsetMs + 120).toISOString(), status: 'OK',
  attributes: { 'service.name': service, ...(source ? { 'agent_health.source': source.name, 'agent_health.source.type': source.type } : {}) },
});

test.describe('Agent Traces → Source column', () => {
  test('with several sources each trace row shows the source name and backend type; the expanded header repeats it', async ({ page }) => {
    const spans = [
      span('a'.repeat(32), 'a1', 'invoke_agent', 'my-agent', { name: 'My OpenSearch', type: 'opensearch' }, 0),
      span('a'.repeat(32), 'a2', 'chat', 'my-agent', { name: 'My OpenSearch', type: 'opensearch' }, 10),
      span('b'.repeat(32), 'b1', 'POST /invoke', 'team-agent', { name: 'Team CloudWatch', type: 'cloudwatch' }, 1000),
    ];
    await page.route('**/api/traces', (r) => r.fulfill({ status: 200, json: { spans, total: spans.length, nextCursor: null, hasMore: false, backend: 'composite' } }));
    await page.route('**/api/traces/health', (r) => r.fulfill({ status: 200, json: { status: 'ok', backend: 'composite' } }));
    await page.goto('/agent-traces');
    await expect(page.getByText('Team CloudWatch')).toBeVisible({ timeout: 30000 });

    const cells = page.getByTestId('trace-source-cell');
    await expect(cells).toHaveCount(2);
    await expect(page.locator('tr', { hasText: 'team-agent' }).getByTestId('trace-source-cell')).toContainText('Team CloudWatch');
    await expect(page.locator('tr', { hasText: 'team-agent' }).getByTestId('trace-source-type')).toHaveText('CloudWatch');
    await expect(page.locator('tr', { hasText: 'my-agent' }).getByTestId('trace-source-cell')).toContainText('My OpenSearch');
    await expect(page.locator('tr', { hasText: 'my-agent' }).getByTestId('trace-source-type')).toHaveText('OpenSearch');

    await page.locator('tr', { hasText: 'team-agent' }).locator('td').first().click();
    await expect(page.getByTestId('expanded-trace-source')).toContainText('Team CloudWatch');
    await expect(page.getByTestId('expanded-trace-source')).toContainText('CloudWatch');
  });

  test('with a single backend the row is identified by the backend type reported by the API', async ({ page }) => {
    const spans = [span('c'.repeat(32), 'c1', 'invoke_agent', 'solo-agent', undefined, 0)];
    await page.route('**/api/traces', (r) => r.fulfill({ status: 200, json: { spans, total: 1, nextCursor: null, hasMore: false, backend: 'cloudwatch' } }));
    await page.route('**/api/traces/health', (r) => r.fulfill({ status: 200, json: { status: 'ok', backend: 'cloudwatch' } }));
    await page.goto('/agent-traces');
    await expect(page.getByText('solo-agent')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('trace-source-cell')).toContainText('cloudwatch');
  });
});
