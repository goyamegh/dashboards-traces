/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/capsules/from-session (Flow 2).
 * Requires the backend running. Validation / no-spans / no-cluster paths run
 * green without a live cluster; the data-bearing happy path is covered by the
 * buildCapsule unit test and the combined-flows test.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    if (!r.ok) return false;
    const d = await r.json();
    return d?.status === 'connected' || d?.status === 'ok';
  } catch {
    return false;
  }
};

const post = (body: unknown) =>
  fetch(`${BASE_URL}/api/capsules/from-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/capsules/from-session', () => {
  let up = false;
  beforeAll(async () => {
    up = await checkBackend();
    if (!up) console.warn('[capsules.integration] backend not running — skipping');
  });

  it('rejects missing sessionId with 400', async () => {
    if (!up) return;
    expect((await post({ testCaseId: 'tc', agent: 'a', rev: 'r' })).status).toBe(400);
  });

  it('rejects missing testCaseId with 400', async () => {
    if (!up) return;
    expect((await post({ sessionId: 's', agent: 'a', rev: 'r' })).status).toBe(400);
  });

  it('rejects missing agent/rev with 400', async () => {
    if (!up) return;
    expect((await post({ sessionId: 's', testCaseId: 'tc' })).status).toBe(400);
  });

  it('with full valid input reaches the fetch stage (404/502/503, not 400)', async () => {
    if (!up) return;
    const res = await post({ sessionId: 'nonexistent-zzz', testCaseId: 'tc', agent: 'a', rev: 'r' });
    expect([404, 502, 503]).toContain(res.status);
    expect((await res.json()).error).not.toMatch(/required/i);
  });
});
