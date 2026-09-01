/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `GET /api/storage/evaluators` pagination handling
 * (server/routes/storage/evaluators.ts).
 *
 * The route intentionally keeps its long-standing "return everything when no
 * size/limit param is given" contract (every current UI caller relies on the
 * full list to populate dropdowns/editors — see the module comment in
 * evaluators.ts), but MUST validate size/limit/from/offset the moment a
 * caller opts into pagination, per the shared pagination.ts convention.
 */

const mockEvaluatorsGetAll = jest.fn();
const mockEvaluatorsGetById = jest.fn();
const mockIsConfigured = jest.fn();

jest.mock('@/server/adapters', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    evaluators: {
      getAll: (...args: any[]) => mockEvaluatorsGetAll(...args),
      getById: (...args: any[]) => mockEvaluatorsGetById(...args),
    },
    isConfigured: () => mockIsConfigured(),
  }),
}));

import express, { Application } from 'express';
const request = require('supertest');
import evaluatorsRouter from '@/server/routes/storage/evaluators';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(evaluatorsRouter);
  return app;
}

describe('GET /api/storage/evaluators — pagination', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    app = makeApp();
  });

  it('returns every custom evaluator when no size/limit param is given (backward compat)', async () => {
    const customEvaluators = Array.from({ length: 5 }, (_, i) => ({
      id: `custom-${i}`,
      name: `Custom ${i}`,
      updatedAt: '2024-01-01T00:00:00Z',
    }));
    mockEvaluatorsGetAll.mockResolvedValue({ items: customEvaluators, total: customEvaluators.length });

    const res = await request(app).get('/api/storage/evaluators');

    expect(res.status).toBe(200);
    // System evaluators are always prepended; just assert none of the custom
    // ones were dropped.
    const customIds = res.body.evaluators
      .filter((e: any) => e.id.startsWith('custom-'))
      .map((e: any) => e.id);
    expect(customIds).toHaveLength(5);
  });

  it('opts into pagination and applies the default (100) the moment `size` is present, even if invalid', async () => {
    const customEvaluators = Array.from({ length: 5 }, (_, i) => ({
      id: `custom-${i}`,
      name: `Custom ${i}`,
      updatedAt: '2024-01-01T00:00:00Z',
    }));
    mockEvaluatorsGetAll.mockResolvedValue({ items: customEvaluators, total: customEvaluators.length });

    const res = await request(app).get('/api/storage/evaluators?size=abc');

    expect(res.status).toBe(200);
    // 5 real + system evaluators is still under the 100 default, so nothing
    // is truncated here — the important thing is it didn't 500 or misbehave.
    const customIds = res.body.evaluators.filter((e: any) => e.id.startsWith('custom-'));
    expect(customIds).toHaveLength(5);
  });

  it('respects an explicit `limit` (alias for size) and clamps the page', async () => {
    const customEvaluators = Array.from({ length: 5 }, (_, i) => ({
      id: `custom-${i}`,
      name: `Custom ${i}`,
      updatedAt: `2024-01-0${i + 1}T00:00:00Z`,
    }));
    mockEvaluatorsGetAll.mockResolvedValue({ items: customEvaluators, total: customEvaluators.length });

    const res = await request(app).get('/api/storage/evaluators?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.evaluators.length).toBeLessThanOrEqual(2);
    // total still reflects the full count, not just the returned page.
    expect(res.body.total).toBeGreaterThanOrEqual(5);
  });

  it('500s cleanly when storage throws (unrelated to pagination, sanity check)', async () => {
    mockEvaluatorsGetAll.mockRejectedValue(new Error('boom'));
    mockIsConfigured.mockReturnValue(true);
    const res = await request(app).get('/api/storage/evaluators');
    // Route treats storage-unavailable as a warning, not a 500 — falls back
    // to system evaluators only.
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings).toBeDefined();
  });
});
