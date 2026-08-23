/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Finding 1: no-silent-fallback guard on storage entity CRUD.
 *
 * When a storage cluster is configured but unreachable, the runtime state is
 * `backend: 'error'` yet the module singleton is still the default
 * FileStorageModule. Without a guard, `/api/storage/*` CRUD would silently
 * read/write LOCAL file data while reporting "error" — a split-brain. The
 * guard returns 503 for entity CRUD in that state, while leaving the
 * config/recovery admin routes reachable so the operator can fix or fall back.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Keep the REAL storage state singleton (setStorageError/getStorageState) so
// the guard sees genuine state transitions — but stub getStorageModule so the
// data routes never touch disk if they are (incorrectly) reached.
jest.mock('@/server/adapters/index', () => {
  const actual: any = jest.requireActual('@/server/adapters/index');
  return {
    ...actual,
    getStorageModule: jest.fn(() => ({
      isConfigured: jest.fn(() => true),
      testCases: { getAll: jest.fn(async () => ({ items: [], total: 0 })) },
      benchmarks: { getAll: jest.fn(async () => ({ items: [], total: 0 })) },
      runs: { getAll: jest.fn(async () => ({ items: [], total: 0 })) },
    })),
  };
});

import storageRouter from '@/server/routes/storage/index';
import { setStorageError, setStorageModule, FileStorageModule } from '@/server/adapters/index';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(storageRouter);
  return app;
}

describe('storage error-state guard (Finding 1: no silent file fallback)', () => {
  const app = makeApp();

  afterEach(() => {
    // Reset to clean file storage so tests don't leak state into each other.
    setStorageModule(new FileStorageModule(), {
      backend: 'file', configKey: null, error: null, configuredEndpoint: null,
    });
  });

  it('returns 503 for entity CRUD when a configured cluster is unreachable', async () => {
    setStorageError('getaddrinfo ENOTFOUND cluster', 'sigv4|https://cluster|us-east-1||es', 'https://cluster');

    const res = await request(app).get('/api/storage/test-cases');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('storage_unavailable');
    expect(res.body.backend).toBe('error');
    expect(res.body.configuredEndpoint).toBe('https://cluster');
    expect(res.body.message).toMatch(/Refusing to silently read\/write local file data/);
  });

  it('leaves the config/recovery admin routes reachable in error state (so it can be fixed)', async () => {
    setStorageError('boom', 'sigv4|https://cluster|us-east-1||es', 'https://cluster');

    // /api/storage/health is an admin route mounted BEFORE the guard.
    const res = await request(app).get('/api/storage/health');
    expect(res.status).not.toBe(503);
  });

  it('does NOT block entity CRUD in normal file mode (reaches the route, 200 + shape)', async () => {
    setStorageModule(new FileStorageModule(), {
      backend: 'file', configKey: null, error: null, configuredEndpoint: null,
    });

    const res = await request(app).get('/api/storage/test-cases');
    // Must actually reach the test-cases handler successfully — not just "not 503"
    // (which would also pass on a 404/500).
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('testCases');
    expect(res.body).toHaveProperty('total');
  });
});
