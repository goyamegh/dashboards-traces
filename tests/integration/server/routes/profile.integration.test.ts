/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/profile (profile-as-API).
 *
 * Requires the backend server running:
 *   npm run dev:server
 * Run:
 *   npm run test:integration -- --testPathPattern=profile.integration
 *
 * These assert the deterministic request/response contract that the CLI, the
 * UI panel, and any MCP tool all depend on. The validation + error paths
 * (400 / 404 / 503) short-circuit before any observability query, so they run
 * green without a live OpenSearch cluster. The 200 happy path needs a cluster
 * + a real session, so it is covered by the unit test on `buildProfile` and an
 * e2e against live data; here we pin the contract edges.
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

const postProfile = (body: unknown) =>
  fetch(`${BASE_URL}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/profile', () => {
  let backendUp = false;
  beforeAll(async () => {
    backendUp = await checkBackend();
    if (!backendUp) console.warn('[profile.integration] backend not running — skipping');
  });

  it('rejects a missing sessionId with 400', async () => {
    if (!backendUp) return;
    const res = await postProfile({ evaluatorId: 'system-rca-default' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/i);
  });

  it('rejects a non-string sessionId with 400', async () => {
    if (!backendUp) return;
    const res = await postProfile({ sessionId: 123 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string userFeedback with 400', async () => {
    if (!backendUp) return;
    const res = await postProfile({ sessionId: 'sess-1', userFeedback: { not: 'a string' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/userFeedback/i);
  });

  it('returns 404 for an unknown evaluator id (before any trace fetch)', async () => {
    if (!backendUp) return;
    const res = await postProfile({ sessionId: 'sess-1', evaluatorId: 'definitely-not-an-evaluator-xyz' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/evaluator not found/i);
  });

  it('resolves the default evaluator then fails downstream (404/502/503), not on the evaluator', async () => {
    if (!backendUp) return;
    // sessionId valid + default system evaluator resolves → the next gates are
    // the observability cluster and the span fetch. Acceptable downstream
    // outcomes: 503 (no cluster), 502 (cluster errored / creds expired), or
    // 404 (cluster ok but no spans for this fake session). The invariant we
    // assert is that resolution got PAST the evaluator — i.e. it must NOT be a
    // 404 about the evaluator.
    const res = await postProfile({ sessionId: 'nonexistent-session-zzz' });
    expect([404, 502, 503]).toContain(res.status);
    const body = await res.json();
    expect(body.error).not.toMatch(/evaluator not found/i);
  });
});
