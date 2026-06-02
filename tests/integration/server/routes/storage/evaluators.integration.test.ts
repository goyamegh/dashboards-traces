/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the evaluator CRUD API.
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=evaluators.integration
 *
 * Covers the request/response surface that the redesigned
 * EvaluatorEditPage relies on:
 *   - Create custom evaluator (POST → 201)
 *   - Round-trip get-by-id (GET → matches what we sent)
 *   - Update creates a new version (PUT → currentVersion bumps)
 *   - Reject PUT to a system evaluator id (400)
 *   - Reject DELETE of a system evaluator id (400)
 *   - Reject creating with a system id (400)
 *   - DELETE a custom evaluator
 *   - 404 for unknown ids
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const SYSTEM_ID = 'system-rca-default'; // Always present from server/prompts/evaluatorTemplates.ts

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    if (!response.ok) return false;
    const data = await response.json();
    // The shape differs by storage backend:
    //   - file-backed: { status: 'connected' }
    //   - OpenSearch:  { status: 'ok',  cluster: { ... } }
    // Either is sufficient for the routes under test.
    return data?.status === 'connected' || data?.status === 'ok';
  } catch {
    return false;
  }
};

const createPayload = (suffix: string) => ({
  name: `Integration Eval ${suffix}`,
  description: 'Created by evaluators.integration.test.ts — safe to delete',
  systemPrompt: 'You are an integration-test judge. Score the agent.',
  scoringConfig: {
    metrics: [
      { name: 'accuracy', description: 'Overall accuracy', weight: 1.0, scale: 100 },
    ],
    passThreshold: 70,
    scale: 100,
  },
  inferenceConfig: {
    temperature: 0.1,
    maxTokens: 4096,
  },
});

describe('Evaluators CRUD Integration Tests', () => {
  let backendAvailable = false;
  const createdIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
    }
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;
    // Tracked-id cleanup — never leak custom evaluators between runs
    for (const id of createdIds) {
      await fetch(`${BASE_URL}/api/storage/evaluators/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    // Best-effort fallback: nuke any leftovers by name prefix
    try {
      const resp = await fetch(`${BASE_URL}/api/storage/evaluators`);
      if (resp.ok) {
        const data = await resp.json();
        const items: Array<{ id: string; name: string; isSystem: boolean }> =
          data.evaluators ?? data.items ?? [];
        for (const ev of items) {
          if (!ev.isSystem && ev.name?.startsWith('Integration Eval ')) {
            await fetch(
              `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(ev.id)}`,
              { method: 'DELETE' },
            ).catch(() => {});
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, 30000);

  it('POST creates a custom evaluator and GET round-trips the content', async () => {
    if (!backendAvailable) return;

    const payload = createPayload('round-trip');
    const createResp = await fetch(`${BASE_URL}/api/storage/evaluators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(createResp.status).toBe(201);
    const created = await createResp.json();
    expect(created.id).toBeTruthy();
    expect(created.isSystem).toBe(false);
    expect(created.currentVersion).toBe(1);
    createdIds.push(created.id);

    const getResp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(created.id)}`,
    );
    expect(getResp.ok).toBe(true);
    const fetched = await getResp.json();

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(payload.name);
    expect(fetched.description).toBe(payload.description);
    expect(fetched.systemPrompt).toBe(payload.systemPrompt);
    expect(fetched.scoringConfig.passThreshold).toBe(70);
    expect(fetched.scoringConfig.metrics).toHaveLength(1);
    expect(fetched.scoringConfig.metrics[0].name).toBe('accuracy');
  });

  it('PUT bumps currentVersion when content changes', async () => {
    if (!backendAvailable) return;

    const created = await fetch(`${BASE_URL}/api/storage/evaluators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createPayload('versioning')),
    }).then((r) => r.json());
    createdIds.push(created.id);
    expect(created.currentVersion).toBe(1);

    // Update with a different system prompt
    const updateResp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(created.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...created,
          systemPrompt: 'Different prompt — should produce v2.',
        }),
      },
    );

    expect(updateResp.ok).toBe(true);
    const updated = await updateResp.json();
    expect(updated.currentVersion).toBeGreaterThan(1);

    // Latest GET reflects new content
    const latest = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(created.id)}`,
    ).then((r) => r.json());
    expect(latest.systemPrompt).toBe('Different prompt — should produce v2.');
    expect(latest.currentVersion).toBe(updated.currentVersion);
  });

  it('rejects POST with a reserved system id (400)', async () => {
    if (!backendAvailable) return;

    const resp = await fetch(`${BASE_URL}/api/storage/evaluators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: SYSTEM_ID, ...createPayload('rejected') }),
    });

    expect(resp.status).toBe(400);
    const err = await resp.json();
    expect(err.error).toMatch(/system evaluator/i);
  });

  it('rejects PUT against a system evaluator id (400)', async () => {
    if (!backendAvailable) return;

    const resp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(SYSTEM_ID)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: 'tampering attempt' }),
      },
    );
    expect(resp.status).toBe(400);
    const err = await resp.json();
    expect(err.error).toMatch(/system evaluator/i);
  });

  it('rejects DELETE against a system evaluator id (400)', async () => {
    if (!backendAvailable) return;

    const resp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(SYSTEM_ID)}`,
      { method: 'DELETE' },
    );
    expect(resp.status).toBe(400);
  });

  it('returns 404 for an unknown evaluator id', async () => {
    if (!backendAvailable) return;

    const resp = await fetch(
      `${BASE_URL}/api/storage/evaluators/eval-does-not-exist-zzz`,
    );
    expect(resp.status).toBe(404);
  });

  it('DELETE removes a custom evaluator and subsequent GET 404s', async () => {
    if (!backendAvailable) return;

    const created = await fetch(`${BASE_URL}/api/storage/evaluators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createPayload('delete-me')),
    }).then((r) => r.json());

    const delResp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(created.id)}`,
      { method: 'DELETE' },
    );
    expect(delResp.ok).toBe(true);
    const result = await delResp.json();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const followUp = await fetch(
      `${BASE_URL}/api/storage/evaluators/${encodeURIComponent(created.id)}`,
    );
    expect(followUp.status).toBe(404);
    // Note: don't push to createdIds — already deleted.
  });
});
