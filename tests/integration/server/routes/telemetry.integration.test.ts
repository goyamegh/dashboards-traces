/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the UI telemetry sink (POST /api/telemetry/ui-event).
 * Verifies the real server route: valid events return 204, invalid events 400.
 *
 * Prerequisites: backend running (npm run dev:server).
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
};

const post = (body: unknown) =>
  fetch(`${BASE_URL}/api/telemetry/ui-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('UI Telemetry Endpoint Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) console.warn('Backend not available at', BASE_URL, '- skipping');
  }, TEST_TIMEOUT);

  it('accepts a valid ui-event with 204', async () => {
    if (!backendAvailable) return;
    const res = await post({ event: 'comparison_search_scope', props: { scope: 'run' } });
    expect(res.status).toBe(204);
  }, TEST_TIMEOUT);

  it('accepts an event with no props', async () => {
    if (!backendAvailable) return;
    const res = await post({ event: 'comparison_search_select' });
    expect(res.status).toBe(204);
  }, TEST_TIMEOUT);

  it('rejects a missing/empty event with 400', async () => {
    if (!backendAvailable) return;
    const res = await post({ props: { scope: 'benchmark' } });
    expect(res.status).toBe(400);
  }, TEST_TIMEOUT);

  it('rejects an over-long event name with 400', async () => {
    if (!backendAvailable) return;
    const res = await post({ event: 'x'.repeat(200) });
    expect(res.status).toBe(400);
  }, TEST_TIMEOUT);
});
