/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Observability Data Source renders the CloudWatch backend.
 *
 * With `observability.type: 'cloudwatch'` the server reports no endpoint; the
 * page must show a read-only CloudWatch panel (region / profile / log groups)
 * instead of an OpenSearch form with an empty Endpoint URL, and Test
 * Connection must hit the CloudWatch branch of /api/observability/test-connection.
 */

import { test, expect } from './fixtures/test-fixtures';

const STATS_OK = { stats: { evals_test_cases: { count: 0 }, evals_experiments: { count: 0 }, evals_runs: { count: 0 }, evals_analytics: { count: 0 } } };

const CLOUDWATCH_STATUS = {
  storage: { configured: false, source: 'none' },
  observability: {
    configured: true,
    source: 'typescript',
    type: 'cloudwatch',
    awsRegion: 'us-east-1',
    awsProfile: 'default',
    logGroups: { traces: 'aws/spans', logs: '/agent-health/{service.name}' },
  },
};

const OPENSEARCH_STATUS = {
  storage: { configured: false, source: 'none' },
  observability: { configured: true, source: 'typescript', type: 'opensearch', endpoint: 'https://obs.example.com', indexes: { traces: 'otel-v1-apm-span-*' } },
};

async function openSettings(page: any, status: unknown) {
  await page.route('**/api/storage/config/status', (r: any) => r.fulfill({ status: 200, json: status }));
  await page.route('**/api/storage/stats', (r: any) => r.fulfill({ status: 200, json: STATS_OK }));
  await page.route('**/api/storage/health', (r: any) => r.fulfill({ status: 200, json: { status: 'ok', backend: 'file' } }));
  await page.goto('/settings');
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
}

test.describe('Settings → Observability: CloudWatch backend', () => {
  test('renders the read-only CloudWatch panel with region, profile and log groups', async ({ page }) => {
    await openSettings(page, CLOUDWATCH_STATUS);

    const panel = page.getByTestId('observability-cloudwatch-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText('CloudWatch Logs')).toBeVisible();
    await expect(page.getByTestId('cw-region')).toHaveText('us-east-1');
    await expect(page.getByTestId('cw-profile')).toHaveText('default');
    await expect(page.getByTestId('cw-traces-group')).toHaveText('aws/spans');
    await expect(page.getByTestId('cw-logs-group')).toHaveText('/agent-health/{service.name}');

    // The OpenSearch form (Endpoint URL input) is not shown for this backend.
    await expect(page.locator('#obs-endpoint')).toHaveCount(0);
    await expect(page.getByText('Config file (agent-health.config.ts)')).toBeVisible();
  });

  test('Test Connection posts the CloudWatch shape and shows the server verdict', async ({ page }) => {
    await openSettings(page, CLOUDWATCH_STATUS);
    let body: any = null;
    await page.route('**/api/observability/test-connection', async (r: any) => {
      body = r.request().postDataJSON();
      await r.fulfill({ status: 200, json: { status: 'ok', latencyMs: 87, clusterName: 'CloudWatch Logs (us-east-1)', clusterStatus: 'aws/spans', message: "No log groups matching '/agent-health/{service.name}' found yet" } });
    });

    await page.getByTestId('observability-cloudwatch-panel').getByRole('button', { name: 'Test Connection' }).click();
    await expect(page.getByText(/Connected to CloudWatch Logs \(us-east-1\) \(87ms\)/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/No log groups matching/)).toBeVisible();
    expect(body).toMatchObject({ type: 'cloudwatch', awsRegion: 'us-east-1', awsProfile: 'default', logGroups: { traces: 'aws/spans' } });
    expect(body.endpoint).toBeUndefined();
  });

  test('Test Connection surfaces a credential error from the server', async ({ page }) => {
    await openSettings(page, CLOUDWATCH_STATUS);
    await page.route('**/api/observability/test-connection', (r: any) =>
      r.fulfill({ status: 200, json: { status: 'error', message: 'The security token included in the request is expired — Refresh the AWS credentials for the configured profile' } })
    );
    await page.getByTestId('observability-cloudwatch-panel').getByRole('button', { name: 'Test Connection' }).click();
    await expect(page.getByText(/security token included in the request is expired/)).toBeVisible({ timeout: 15000 });
  });

  test('an OpenSearch observability config still renders the endpoint form', async ({ page }) => {
    await openSettings(page, OPENSEARCH_STATUS);
    await expect(page.locator('#obs-endpoint')).toHaveValue('https://obs.example.com');
    await expect(page.getByTestId('observability-cloudwatch-panel')).toHaveCount(0);
  });
});
