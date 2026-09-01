/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockStorageIsConfigured = jest.fn();
const mockEvaluatorsGetAll = jest.fn();
const mockEvaluatorsGetById = jest.fn();
const mockEvaluatorsGetVersions = jest.fn();
const mockEvaluatorsGetVersion = jest.fn();
const mockEvaluatorsCreate = jest.fn();
const mockEvaluatorsUpdate = jest.fn();
const mockEvaluatorsDelete = jest.fn();
const mockGetStorageModule = jest.fn();
const mockDebug = jest.fn();
const mockGetSystemEvaluatorById = jest.fn();
const mockIsSystemEvaluatorId = jest.fn((id: string) => id.startsWith('system-'));
const mockToEvaluator = jest.fn((template: any) => ({
  id: template.id,
  name: template.name,
  updatedAt: template.updatedAt ?? '2024-01-01T00:00:00.000Z',
}));

const systemTemplates = [
  { id: 'system-beta', name: 'Beta Evaluator', updatedAt: '2024-01-02T00:00:00.000Z' },
  { id: 'system-alpha', name: 'Alpha Evaluator', updatedAt: '2024-01-01T00:00:00.000Z' },
];

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

jest.mock('@/server/adapters', () => ({
  getStorageModule: (...args: any[]) => mockGetStorageModule(...args),
}));

jest.mock('@/server/prompts/evaluatorTemplates', () => ({
  SYSTEM_EVALUATORS: systemTemplates,
  toEvaluator: (...args: any[]) => mockToEvaluator(...args),
  isSystemEvaluatorId: (...args: any[]) => mockIsSystemEvaluatorId(...args),
  getSystemEvaluatorById: (...args: any[]) => mockGetSystemEvaluatorById(...args),
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

function makeStorage() {
  return {
    isConfigured: (...args: any[]) => mockStorageIsConfigured(...args),
    evaluators: {
      getAll: (...args: any[]) => mockEvaluatorsGetAll(...args),
      getById: (...args: any[]) => mockEvaluatorsGetById(...args),
      getVersions: (...args: any[]) => mockEvaluatorsGetVersions(...args),
      getVersion: (...args: any[]) => mockEvaluatorsGetVersion(...args),
      create: (...args: any[]) => mockEvaluatorsCreate(...args),
      update: (...args: any[]) => mockEvaluatorsUpdate(...args),
      delete: (...args: any[]) => mockEvaluatorsDelete(...args),
    },
  };
}

describe('Evaluators router', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetStorageModule.mockReturnValue(makeStorage());
    mockStorageIsConfigured.mockReturnValue(true);
    mockEvaluatorsGetAll.mockResolvedValue({ items: [] });
    mockEvaluatorsGetById.mockResolvedValue(null);
    mockEvaluatorsGetVersions.mockResolvedValue([]);
    mockEvaluatorsGetVersion.mockResolvedValue(null);
    mockEvaluatorsCreate.mockImplementation(async (input: any) => ({ id: input.id ?? 'custom-created', ...input }));
    mockEvaluatorsUpdate.mockImplementation(async (id: string, body: any) => ({ id, currentVersion: 2, ...body }));
    mockEvaluatorsDelete.mockResolvedValue({ deleted: 1 });
    mockGetSystemEvaluatorById.mockImplementation((id: string) => systemTemplates.find((template) => template.id === id) ?? null);
    app = makeApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/storage/evaluators', () => {
    it('lists sorted system evaluators when storage is not configured', async () => {
      mockStorageIsConfigured.mockReturnValue(false);

      const res = await request(app).get('/api/storage/evaluators');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        evaluators: [
          { id: 'system-alpha', name: 'Alpha Evaluator', updatedAt: '2024-01-01T00:00:00.000Z' },
          { id: 'system-beta', name: 'Beta Evaluator', updatedAt: '2024-01-02T00:00:00.000Z' },
        ],
        total: 2,
        meta: {
          storageConfigured: false,
          storageReachable: false,
          realDataCount: 0,
          sampleDataCount: 2,
        },
      });
      expect(mockEvaluatorsGetAll).not.toHaveBeenCalled();
    });

    it('filters ids across system and custom evaluators', async () => {
      mockEvaluatorsGetById.mockResolvedValue({
        id: 'custom-2',
        name: 'Custom Two',
        updatedAt: '2024-02-01T00:00:00.000Z',
      });

      const res = await request(app).get('/api/storage/evaluators?ids=system-beta,custom-2,');

      expect(res.status).toBe(200);
      expect(mockEvaluatorsGetById).toHaveBeenCalledWith('custom-2');
      expect(res.body.evaluators).toEqual([
        { id: 'system-beta', name: 'Beta Evaluator', updatedAt: '2024-01-02T00:00:00.000Z' },
        { id: 'custom-2', name: 'Custom Two', updatedAt: '2024-02-01T00:00:00.000Z' },
      ]);
      expect(res.body.meta).toEqual({
        storageConfigured: true,
        storageReachable: true,
        realDataCount: 1,
        sampleDataCount: 1,
      });
    });

    it('lists all custom evaluators sorted by updatedAt descending after system evaluators', async () => {
      mockEvaluatorsGetAll.mockResolvedValue({
        items: [
          { id: 'custom-older', name: 'Older', updatedAt: '2024-01-05T00:00:00.000Z' },
          { id: 'custom-newer', name: 'Newer', updatedAt: '2024-03-05T00:00:00.000Z' },
        ],
      });

      const res = await request(app).get('/api/storage/evaluators');

      expect(res.status).toBe(200);
      expect(res.body.evaluators.map((e: any) => e.id)).toEqual([
        'system-alpha',
        'system-beta',
        'custom-newer',
        'custom-older',
      ]);
    });

    it('returns system evaluators with warnings when storage access fails', async () => {
      mockEvaluatorsGetAll.mockRejectedValue(new Error('storage offline'));

      const res = await request(app).get('/api/storage/evaluators');

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({
        storageConfigured: true,
        storageReachable: false,
        realDataCount: 0,
        sampleDataCount: 2,
        warnings: ['Storage unavailable: storage offline'],
      });
      expect(console.warn).toHaveBeenCalledWith(
        '[StorageAPI] Storage unavailable, returning system evaluators only:',
        'storage offline'
      );
    });

    it('returns 500 when storage module lookup throws', async () => {
      mockGetStorageModule.mockImplementationOnce(() => {
        throw new Error('adapter boom');
      });

      const res = await request(app).get('/api/storage/evaluators');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'adapter boom' });
    });
  });

  describe('GET /api/storage/evaluators/:id', () => {
    it('returns a system evaluator by id', async () => {
      const res = await request(app).get('/api/storage/evaluators/system-alpha');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 'system-alpha',
        name: 'Alpha Evaluator',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(mockEvaluatorsGetById).not.toHaveBeenCalled();
    });

    it('returns 404 when a system evaluator id has no template', async () => {
      mockGetSystemEvaluatorById.mockReturnValueOnce(null);

      const res = await request(app).get('/api/storage/evaluators/system-missing');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator not found' });
    });

    it('returns a custom evaluator by id', async () => {
      mockEvaluatorsGetById.mockResolvedValue({ id: 'custom-1', name: 'Custom One' });

      const res = await request(app).get('/api/storage/evaluators/custom-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'custom-1', name: 'Custom One' });
    });

    it('returns 404 when a custom evaluator is missing', async () => {
      const res = await request(app).get('/api/storage/evaluators/custom-missing');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator not found' });
    });

    it('returns 500 when getById throws', async () => {
      mockEvaluatorsGetById.mockRejectedValue(new Error('read failed'));

      const res = await request(app).get('/api/storage/evaluators/custom-1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'read failed' });
    });
  });

  describe('GET /api/storage/evaluators/:id/versions', () => {
    it('returns a single version for a system evaluator', async () => {
      const res = await request(app).get('/api/storage/evaluators/system-alpha/versions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        versions: [{ id: 'system-alpha', name: 'Alpha Evaluator', updatedAt: '2024-01-01T00:00:00.000Z' }],
        total: 1,
      });
    });

    it('returns custom versions from storage', async () => {
      mockEvaluatorsGetVersions.mockResolvedValue([{ id: 'custom-1', version: 1 }, { id: 'custom-1', version: 2 }]);

      const res = await request(app).get('/api/storage/evaluators/custom-1/versions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        versions: [{ id: 'custom-1', version: 1 }, { id: 'custom-1', version: 2 }],
        total: 2,
      });
    });

    it('returns 404 when no custom versions exist', async () => {
      const res = await request(app).get('/api/storage/evaluators/custom-1/versions');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator not found' });
    });

    it('returns 500 when versions lookup throws', async () => {
      mockEvaluatorsGetVersions.mockRejectedValue(new Error('versions failed'));

      const res = await request(app).get('/api/storage/evaluators/custom-1/versions');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'versions failed' });
    });
  });

  describe('GET /api/storage/evaluators/:id/versions/:version', () => {
    it('returns system evaluator version 1', async () => {
      const res = await request(app).get('/api/storage/evaluators/system-alpha/versions/1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('system-alpha');
    });

    it('returns 404 for non-existent system evaluator version', async () => {
      const res = await request(app).get('/api/storage/evaluators/system-alpha/versions/2');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator version not found' });
    });

    it('returns a specific custom evaluator version', async () => {
      mockEvaluatorsGetVersion.mockResolvedValue({ id: 'custom-1', version: 3 });

      const res = await request(app).get('/api/storage/evaluators/custom-1/versions/3');

      expect(res.status).toBe(200);
      expect(mockEvaluatorsGetVersion).toHaveBeenCalledWith('custom-1', 3);
      expect(res.body).toEqual({ id: 'custom-1', version: 3 });
    });

    it('returns 404 when the custom version is missing', async () => {
      const res = await request(app).get('/api/storage/evaluators/custom-1/versions/9');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator version not found' });
    });

    it('returns 500 when getVersion throws', async () => {
      mockEvaluatorsGetVersion.mockRejectedValue(new Error('version read failed'));

      const res = await request(app).get('/api/storage/evaluators/custom-1/versions/2');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'version read failed' });
    });
  });

  describe('POST /api/storage/evaluators', () => {
    it('rejects creation with a system evaluator id', async () => {
      const res = await request(app)
        .post('/api/storage/evaluators')
        .send({ id: 'system-alpha', name: 'Nope', systemPrompt: 'x', scoringConfig: {} });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Cannot create evaluator with system evaluator ID. System evaluators are reserved.',
      });
    });

    it('validates required fields', async () => {
      const noName = await request(app).post('/api/storage/evaluators').send({ systemPrompt: 'x', scoringConfig: {} });
      const noPrompt = await request(app).post('/api/storage/evaluators').send({ name: 'Eval', scoringConfig: {} });
      const noScoring = await request(app).post('/api/storage/evaluators').send({ name: 'Eval', systemPrompt: 'x' });

      expect(noName.status).toBe(400);
      expect(noName.body).toEqual({ error: 'Evaluator name is required' });
      expect(noPrompt.status).toBe(400);
      expect(noPrompt.body).toEqual({ error: 'Evaluator system prompt is required' });
      expect(noScoring.status).toBe(400);
      expect(noScoring.body).toEqual({ error: 'Evaluator scoring config is required' });
    });

    it('creates a custom evaluator', async () => {
      mockEvaluatorsCreate.mockResolvedValue({
        id: 'custom-created',
        name: 'Latency Judge',
        systemPrompt: 'judge',
        scoringConfig: { passThreshold: 0.8 },
      });

      const res = await request(app)
        .post('/api/storage/evaluators')
        .send({ name: 'Latency Judge', systemPrompt: 'judge', scoringConfig: { passThreshold: 0.8 } });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('custom-created');
      expect(mockDebug).toHaveBeenCalledWith('StorageAPI', 'Created evaluator: custom-created v1');
    });

    it('returns 500 when creation fails', async () => {
      mockEvaluatorsCreate.mockRejectedValue(new Error('create failed'));

      const res = await request(app)
        .post('/api/storage/evaluators')
        .send({ name: 'Eval', systemPrompt: 'judge', scoringConfig: {} });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'create failed' });
    });
  });

  describe('PUT /api/storage/evaluators/:id', () => {
    it('rejects updates to system evaluators', async () => {
      const res = await request(app).put('/api/storage/evaluators/system-alpha').send({ name: 'x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Cannot modify system evaluators. Duplicate them to create a custom version.',
      });
    });

    it('creates a new custom evaluator version', async () => {
      mockEvaluatorsUpdate.mockResolvedValue({ id: 'custom-1', currentVersion: 4, name: 'Updated' });

      const res = await request(app).put('/api/storage/evaluators/custom-1').send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'custom-1', currentVersion: 4, name: 'Updated' });
      expect(mockDebug).toHaveBeenCalledWith('StorageAPI', 'Updated evaluator: custom-1 → v4');
    });

    it('returns 500 when update fails', async () => {
      mockEvaluatorsUpdate.mockRejectedValue(new Error('update failed'));

      const res = await request(app).put('/api/storage/evaluators/custom-1').send({ name: 'Updated' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'update failed' });
    });
  });

  describe('DELETE /api/storage/evaluators/:id', () => {
    it('rejects deletion of system evaluators', async () => {
      const res = await request(app).delete('/api/storage/evaluators/system-alpha');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Cannot delete system evaluators. System evaluators are protected.',
      });
    });

    it('returns 404 when no evaluator was deleted', async () => {
      mockEvaluatorsDelete.mockResolvedValue({ deleted: 0 });

      const res = await request(app).delete('/api/storage/evaluators/custom-1');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Evaluator not found' });
    });

    it('deletes custom evaluator versions', async () => {
      mockEvaluatorsDelete.mockResolvedValue({ deleted: 3 });

      const res = await request(app).delete('/api/storage/evaluators/custom-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: 3 });
      expect(mockDebug).toHaveBeenCalledWith('StorageAPI', 'Deleted evaluator: custom-1 (3 version(s))');
    });

    it('returns 500 when delete fails', async () => {
      mockEvaluatorsDelete.mockRejectedValue(new Error('delete failed'));

      const res = await request(app).delete('/api/storage/evaluators/custom-1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'delete failed' });
    });
  });
});
