/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Observability Data Sources: several sources, each `Type → fields`.
 *
 * - the primary and every additional source render as a form with a Type
 *   selector (OpenSearch / Amazon CloudWatch) that swaps the fields;
 * - "Add source" appends a form; Save PUTs the CloudWatch body to
 *   /api/storage/config/observability/sources/:id; Remove DELETEs it;
 * - switching the primary's Type to CloudWatch and saving POSTs the CloudWatch
 *   body (no endpoint) to /api/storage/config/observability;
 * - per-source health badges come from /api/observability/sources/health;
 * - code-first mode renders everything read-only (no Save/Remove/Add).
 */

import { test, expect } from './fixtures/test-fixtures';

const STATS_OK = { stats: { evals_test_cases: { count: 0 }, evals_experiments: { count: 0 }, evals_runs: { count: 0 }, evals_analytics: { count: 0 } } };

const TWO_SOURCES_UI_FIRST = {
  storage: { configured: false, source: 'none' },
  observability: {
    configured: true, source: 'file', type: 'opensearch', endpoint: 'https://mine.example.com', authType: 'basic', username: 'admin', hasPassword: true,
    indexes: { traces: 'otel-v1-apm-span-*' },
    sources: [{ id: 'team-cw', name: 'Team CloudWatch', source: 'file', type: 'cloudwatch', awsRegion: 'us-east-1', awsProfile: 'default', logGroups: { traces: 'aws/spans', logs: '/agent-health/{service.name}' } }],
  },
};
const HEALTH = { sources: [{ id: 'primary', name: 'primary', type: 'opensearch', health: { status: 'ok' } }, { id: 'team-cw', name: 'Team CloudWatch', type: 'cloudwatch', health: { status: 'error', error: "Log group 'aws/spans' not found" } }] };

async function openSettings(page: any, status: unknown, health: unknown = HEALTH) {
  await page.route('**/api/storage/config/status', (r: any) => r.fulfill({ status: 200, json: status }));
  await page.route('**/api/storage/stats', (r: any) => r.fulfill({ status: 200, json: STATS_OK }));
  await page.route('**/api/storage/health', (r: any) => r.fulfill({ status: 200, json: { status: 'ok', backend: 'file' } }));
  await page.route('**/api/observability/sources/health', (r: any) => r.fulfill({ status: 200, json: health }));
  await page.goto('/settings');
  await page.waitForSelector('[data-testid="observability-sources-card"]', { timeout: 30000 });
}

test.describe('Settings → Observability Data Sources (several, Type → fields)', () => {
  test('renders the primary and an additional CloudWatch source with per-source health', async ({ page }) => {
    await openSettings(page, TWO_SOURCES_UI_FIRST);
    await expect(page.getByTestId('observability-source-count')).toHaveText('2 sources');

    const primary = page.getByTestId('observability-source-primary');
    await expect(primary.locator('#obs-primary-endpoint')).toHaveValue('https://mine.example.com');
    await expect(primary.getByTestId('obs-primary-opensearch-fields')).toBeVisible();
    await expect(primary.getByTestId('obs-primary-health')).toContainText('reachable');

    const cw = page.getByTestId('observability-source-team-cw');
    await expect(cw.locator('#obs-team-cw-name')).toHaveValue('Team CloudWatch');
    await expect(cw.getByTestId('obs-team-cw-cloudwatch-fields')).toBeVisible();
    await expect(cw.locator('#obs-team-cw-region')).toHaveValue('us-east-1');
    await expect(cw.locator('#obs-team-cw-traces-group')).toHaveValue('aws/spans');
    await expect(cw.getByTestId('obs-team-cw-health')).toContainText("Log group 'aws/spans' not found");
  });

  test('switching the primary Type to CloudWatch swaps the fields and Save posts the CloudWatch body (no endpoint)', async ({ page }) => {
    await openSettings(page, TWO_SOURCES_UI_FIRST);
    let body: any = null;
    await page.route('**/api/storage/config/observability', async (r: any) => {
      if (r.request().method() === 'POST') { body = r.request().postDataJSON(); return r.fulfill({ status: 200, json: { success: true } }); }
      return r.continue();
    });
    const primary = page.getByTestId('observability-source-primary');
    await primary.getByTestId('obs-primary-type').click();
    await page.getByRole('option', { name: 'Amazon CloudWatch' }).click();
    await expect(primary.getByTestId('obs-primary-cloudwatch-fields')).toBeVisible();
    await expect(primary.locator('#obs-primary-endpoint')).toHaveCount(0);
    await primary.locator('#obs-primary-region').fill('eu-west-1');
    await primary.locator('#obs-primary-profile').fill('obs');
    await primary.getByTestId('obs-primary-save').click();
    await expect(primary.getByTestId('obs-primary-verdict')).toContainText('Saved');
    expect(body).toMatchObject({ type: 'cloudwatch', awsRegion: 'eu-west-1', awsProfile: 'obs' });
    expect(body.endpoint).toBeUndefined();
  });

  test('Add source → new form defaults to CloudWatch; Save PUTs to /sources/:id; Remove DELETEs it', async ({ page }) => {
    await openSettings(page, TWO_SOURCES_UI_FIRST);
    const puts: Array<{ url: string; body: any }> = [];
    const deletes: string[] = [];
    await page.route('**/api/storage/config/observability/sources/*', async (r: any) => {
      if (r.request().method() === 'PUT') { puts.push({ url: r.request().url(), body: r.request().postDataJSON() }); return r.fulfill({ status: 200, json: { success: true } }); }
      if (r.request().method() === 'DELETE') { deletes.push(r.request().url()); return r.fulfill({ status: 200, json: { success: true } }); }
      return r.continue();
    });
    await page.getByTestId('observability-add-source').click();
    const forms = page.locator('[data-testid^="observability-source-"]:not([data-testid="observability-source-count"])');
    await expect(forms).toHaveCount(3);
    const added = forms.nth(2);
    const id = (await added.getAttribute('data-testid'))!.replace('observability-source-', '');
    await expect(added.getByTestId(`obs-${id}-cloudwatch-fields`)).toBeVisible();
    await added.locator(`#obs-${id}-name`).fill('Second account');
    await added.locator(`#obs-${id}-region`).fill('us-west-2');
    await added.getByTestId(`obs-${id}-save`).click();
    await expect(added.getByTestId(`obs-${id}-verdict`)).toContainText('Saved');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`/api/storage/config/observability/sources/${id}`);
    expect(puts[0].body).toMatchObject({ type: 'cloudwatch', name: 'Second account', awsRegion: 'us-west-2' });

    page.once('dialog', (d) => d.accept());
    await page.getByTestId('observability-source-team-cw').getByTestId('obs-team-cw-remove').click();
    await expect.poll(() => deletes.length).toBe(1);
    expect(deletes[0]).toContain('/api/storage/config/observability/sources/team-cw');
  });

  test('Test Connection on a CloudWatch source posts the CloudWatch shape and shows the verdict', async ({ page }) => {
    await openSettings(page, TWO_SOURCES_UI_FIRST);
    let body: any = null;
    await page.route('**/api/observability/test-connection', async (r: any) => {
      body = r.request().postDataJSON();
      await r.fulfill({ status: 200, json: { status: 'ok', latencyMs: 91, clusterName: 'CloudWatch Logs (us-east-1)' } });
    });
    await page.getByTestId('observability-source-team-cw').getByTestId('obs-team-cw-test').click();
    await expect(page.getByTestId('obs-team-cw-verdict')).toContainText('Connected to CloudWatch Logs (us-east-1) (91ms)');
    expect(body).toMatchObject({ type: 'cloudwatch', awsRegion: 'us-east-1', awsProfile: 'default' });
  });

  test('code-first mode is read-only: no Save / Remove / Add, Test Connection still offered', async ({ page }) => {
    const codeFirst = { ...TWO_SOURCES_UI_FIRST, observability: { ...TWO_SOURCES_UI_FIRST.observability, source: 'typescript', sources: TWO_SOURCES_UI_FIRST.observability.sources.map((s) => ({ ...s, source: 'typescript' })) } };
    await openSettings(page, codeFirst);
    await expect(page.getByTestId('observability-readonly-note')).toBeVisible();
    await expect(page.getByTestId('observability-add-source')).toHaveCount(0);
    await expect(page.getByTestId('obs-primary-save')).toHaveCount(0);
    await expect(page.getByTestId('obs-team-cw-remove')).toHaveCount(0);
    await expect(page.getByTestId('obs-team-cw-test')).toBeVisible();
    await expect(page.locator('#obs-primary-endpoint')).toBeDisabled();
  });
});
