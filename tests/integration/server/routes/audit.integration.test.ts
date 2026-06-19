/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/audit/query (Flow 3).
 *
 * Requires the backend running (npm run dev:server). The validation / rule-
 * compilation / no-cluster paths short-circuit before any search, so they run
 * green without a live OpenSearch cluster; the data-bearing happy path is
 * covered by the combined-flows integration test against seeded spans.
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

const postAudit = (body: unknown) =>
  fetch(`${BASE_URL}/api/audit/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/audit/query', () => {
  let up = false;
  beforeAll(async () => {
    up = await checkBackend();
    if (!up) console.warn('[audit.integration] backend not running — skipping');
  });

  it('rejects a missing rule with 400', async () => {
    if (!up) return;
    const res = await postAudit({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rule/i);
  });

  it('rejects a condition-less rule with 400 (no full-index scan)', async () => {
    if (!up) return;
    const res = await postAudit({ rule: { id: 'empty' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no conditions/i);
  });

  it('compiles a valid rule and reaches the search stage (200/502/503, not 400)', async () => {
    if (!up) return;
    const res = await postAudit({
      rule: { id: 'refund-low-score', all: [{ type: 'tool_called', tool: 'Refund' }] },
      size: 10,
    });
    // 200 (cluster ok), 502 (cluster errored), or 503 (no cluster) — but NOT
    // 400, proving the rule compiled and passed validation.
    expect([200, 502, 503]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.ruleId).toBe('refund-low-score');
      expect(Array.isArray(body.hits)).toBe(true);
    }
  });
});
