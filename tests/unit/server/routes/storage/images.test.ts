/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Benchmark Images API router
 * (server/routes/storage/images.ts) — content-addressed evaluation-condition
 * snapshots. Mounts the real router on a bare Express app with a mocked
 * storage adapter (getStorageModule) and the real (pure) buildImageDoc.
 */

const mockTestCasesGetById = jest.fn();
const mockImagesCreate = jest.fn();
const mockImagesGetAll = jest.fn();
const mockImagesGetByDigest = jest.fn();
const mockImagesUpdate = jest.fn();
const mockImagesDelete = jest.fn();
const mockEvaluationRunsList = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    testCases: { getById: (...args: any[]) => mockTestCasesGetById(...args) },
    images: {
      create: (...args: any[]) => mockImagesCreate(...args),
      getAll: (...args: any[]) => mockImagesGetAll(...args),
      getByDigest: (...args: any[]) => mockImagesGetByDigest(...args),
      update: (...args: any[]) => mockImagesUpdate(...args),
      delete: (...args: any[]) => mockImagesDelete(...args),
    },
    evaluationRuns: { list: (...args: any[]) => mockEvaluationRunsList(...args) },
  }),
}));

import express, { Application } from 'express';
const request = require('supertest');
import imagesRouter from '@/server/routes/storage/images';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(imagesRouter);
  return app;
}

const sampleTestCase = (id: string) => ({
  id,
  name: `TC ${id}`,
  initialPrompt: 'do it',
  category: 'general',
  difficulty: 'easy',
  expectedOutcomes: ['ok'],
  version: 1,
});

const sampleImage = {
  digest: 'digest-abc',
  id: 'img-digest-abc',
  docType: 'benchmark-image',
  tags: ['nightly'],
  testCaseCount: 1,
  testCaseFingerprints: ['fp1'],
  evalConditions: {},
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Benchmark Images API', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    app = makeApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/storage/images', () => {
    it('400s when testCaseIds is missing or empty', async () => {
      const res1 = await request(app).post('/api/storage/images').send({});
      expect(res1.status).toBe(400);
      expect(res1.body.error).toContain('testCaseIds is required');

      const res2 = await request(app).post('/api/storage/images').send({ testCaseIds: [] });
      expect(res2.status).toBe(400);
    });

    it('400s when none of the test case ids exist', async () => {
      mockTestCasesGetById.mockResolvedValue(null);
      const res = await request(app).post('/api/storage/images').send({ testCaseIds: ['tc-missing'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tc-missing');
    });

    it('creates an image (find-or-create) from resolved test cases, ignoring missing ids', async () => {
      mockTestCasesGetById.mockImplementation((id: string) =>
        id === 'tc-1' ? Promise.resolve(sampleTestCase('tc-1')) : Promise.resolve(null)
      );
      mockImagesCreate.mockResolvedValue({ ...sampleImage, tags: [] });

      const res = await request(app)
        .post('/api/storage/images')
        .send({ testCaseIds: ['tc-1', 'tc-missing'], evalConditions: { evaluatorId: 'ev-1' } });

      expect(res.status).toBe(201);
      expect(mockImagesCreate).toHaveBeenCalled();
      expect(res.body.image.digest).toBe('digest-abc');
      expect(res.body.missingTestCaseIds).toEqual(['tc-missing']);
    });

    it('unions requested tags onto a pre-existing image (dedup path)', async () => {
      mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
      mockImagesCreate.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });
      mockImagesUpdate.mockResolvedValue({ ...sampleImage, tags: ['nightly', 'weekly'] });

      const res = await request(app)
        .post('/api/storage/images')
        .send({ testCaseIds: ['tc-1'], tags: ['nightly', 'weekly', '  '] });

      expect(res.status).toBe(201);
      expect(mockImagesUpdate).toHaveBeenCalledWith('digest-abc', { tags: ['nightly', 'weekly'] });
      expect(res.body.image.tags).toEqual(['nightly', 'weekly']);
      expect(res.body.missingTestCaseIds).toBeUndefined();
    });

    it('skips the update call when no new tags are requested', async () => {
      mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
      mockImagesCreate.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });

      const res = await request(app)
        .post('/api/storage/images')
        .send({ testCaseIds: ['tc-1'], tags: ['nightly'] });

      expect(res.status).toBe(201);
      expect(mockImagesUpdate).not.toHaveBeenCalled();
    });

    it('500s when storage throws', async () => {
      mockTestCasesGetById.mockRejectedValue(new Error('storage down'));
      const res = await request(app).post('/api/storage/images').send({ testCaseIds: ['tc-1'] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('storage down');
    });

    describe('dryRun: true (preview — no writes)', () => {
      it('computes and returns the real digest without calling images.create/update', async () => {
        mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
        mockImagesGetByDigest.mockResolvedValue(null);

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1'], tags: ['nightly'], dryRun: true });

        expect(res.status).toBe(200);
        expect(res.body.dryRun).toBe(true);
        expect(res.body.alreadyExists).toBe(false);
        // The preview computes the REAL digest from the resolved test case
        // content (buildImageDoc) — not the fixed `sampleImage` fixture, which
        // only stands in for what images.create() would have returned.
        expect(typeof res.body.image.digest).toBe('string');
        expect(res.body.image.digest.length).toBeGreaterThan(0);
        expect(res.body.image.tags).toEqual(['nightly']);
        expect(mockImagesCreate).not.toHaveBeenCalled();
        expect(mockImagesUpdate).not.toHaveBeenCalled();
      });

      it('reports alreadyExists: true and the existing tags when the image already exists', async () => {
        mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
        mockImagesGetByDigest.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1'], tags: ['nightly', 'weekly'], dryRun: true });

        expect(res.status).toBe(200);
        expect(res.body.alreadyExists).toBe(true);
        expect(res.body.image.tags).toEqual(['nightly', 'weekly']);
        expect(mockImagesCreate).not.toHaveBeenCalled();
        expect(mockImagesUpdate).not.toHaveBeenCalled();
      });

      it('still surfaces missingTestCaseIds in the preview', async () => {
        mockTestCasesGetById.mockImplementation((id: string) =>
          id === 'tc-1' ? Promise.resolve(sampleTestCase('tc-1')) : Promise.resolve(null)
        );
        mockImagesGetByDigest.mockResolvedValue(null);

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1', 'tc-missing'], dryRun: true });

        expect(res.status).toBe(200);
        expect(res.body.dryRun).toBe(true);
        expect(res.body.missingTestCaseIds).toEqual(['tc-missing']);
      });

      it('does NOT swallow a storage read error as "image does not exist" — surfaces 500 instead of a false "would create" (codex_review finding)', async () => {
        mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
        mockImagesGetByDigest.mockRejectedValue(new Error('opensearch unreachable'));

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1'], dryRun: true });

        expect(res.status).toBe(500);
        expect(mockImagesCreate).not.toHaveBeenCalled();
        expect(mockImagesUpdate).not.toHaveBeenCalled();
      });

      it('previews the REAL stored image (real createdAt/fingerprints), not a freshly fabricated doc, when it already exists', async () => {
        mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
        const realExisting = { ...sampleImage, tags: ['nightly'], createdAt: '2020-05-01T00:00:00.000Z' };
        mockImagesGetByDigest.mockResolvedValue(realExisting);

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1'], tags: ['nightly'], dryRun: true });

        expect(res.status).toBe(200);
        // Real stored createdAt survives -- a fabricated buildImageDoc()
        // would have stamped `new Date().toISOString()` instead.
        expect(res.body.image.createdAt).toBe('2020-05-01T00:00:00.000Z');
        expect(res.body.alreadyExists).toBe(true);
        // No new tags requested beyond what's already there -- --apply
        // really would be a no-op, and wouldAddTags must say so by being absent.
        expect(res.body.wouldAddTags).toBeUndefined();
      });

      it('reports wouldAddTags when the image exists but under different tags — alreadyExists alone must not imply --apply is a no-op', async () => {
        mockTestCasesGetById.mockResolvedValue(sampleTestCase('tc-1'));
        mockImagesGetByDigest.mockResolvedValue({ ...sampleImage, tags: ['old-name'] });

        const res = await request(app)
          .post('/api/storage/images')
          .send({ testCaseIds: ['tc-1'], tags: ['new-name'], dryRun: true });

        expect(res.status).toBe(200);
        expect(res.body.alreadyExists).toBe(true);
        expect(res.body.wouldAddTags).toEqual(['new-name']);
        expect(res.body.image.tags).toEqual(['old-name', 'new-name']);
      });
    });
  });

  describe('GET /api/storage/images', () => {
    it('lists images with default pagination', async () => {
      mockImagesGetAll.mockResolvedValue({ items: [sampleImage], total: 1 });
      const res = await request(app).get('/api/storage/images');
      expect(res.status).toBe(200);
      expect(mockImagesGetAll).toHaveBeenCalledWith({ from: 0, size: 100 });
      expect(res.body).toEqual({ images: [sampleImage], total: 1 });
    });

    it('honors from/size query params', async () => {
      mockImagesGetAll.mockResolvedValue({ items: [], total: 0 });
      await request(app).get('/api/storage/images?from=10&size=5');
      expect(mockImagesGetAll).toHaveBeenCalledWith({ from: 10, size: 5 });
    });

    it('500s when storage throws', async () => {
      mockImagesGetAll.mockRejectedValue(new Error('boom'));
      const res = await request(app).get('/api/storage/images');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/storage/images/:digest', () => {
    it('404s when the image does not exist', async () => {
      mockImagesGetByDigest.mockResolvedValue(null);
      const res = await request(app).get('/api/storage/images/nope');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('nope');
    });

    it('returns the image and its comparable runs with default pagination', async () => {
      mockImagesGetByDigest.mockResolvedValue(sampleImage);
      mockEvaluationRunsList.mockResolvedValue({ items: [{ id: 'run-1' }], total: 1 });

      const res = await request(app).get('/api/storage/images/digest-abc');

      expect(res.status).toBe(200);
      expect(mockEvaluationRunsList).toHaveBeenCalledWith({ imageDigest: 'digest-abc', from: 0, size: 500 });
      expect(res.body.image).toEqual(sampleImage);
      expect(res.body.runs).toEqual([{ id: 'run-1' }]);
      expect(res.body.runsTotal).toBe(1);
    });

    it('honors from/size query params for the runs page', async () => {
      mockImagesGetByDigest.mockResolvedValue(sampleImage);
      mockEvaluationRunsList.mockResolvedValue({ items: [], total: 0 });
      await request(app).get('/api/storage/images/digest-abc?from=5&size=20');
      expect(mockEvaluationRunsList).toHaveBeenCalledWith({ imageDigest: 'digest-abc', from: 5, size: 20 });
    });

    it('500s when storage throws', async () => {
      mockImagesGetByDigest.mockRejectedValue(new Error('boom'));
      const res = await request(app).get('/api/storage/images/digest-abc');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/storage/images/:digest/tags', () => {
    it('400s when tag is missing/blank', async () => {
      const res1 = await request(app).post('/api/storage/images/digest-abc/tags').send({});
      expect(res1.status).toBe(400);
      const res2 = await request(app).post('/api/storage/images/digest-abc/tags').send({ tag: '   ' });
      expect(res2.status).toBe(400);
    });

    it('404s when the image does not exist', async () => {
      mockImagesGetByDigest.mockResolvedValue(null);
      const res = await request(app).post('/api/storage/images/nope/tags').send({ tag: 'x' });
      expect(res.status).toBe(404);
    });

    it('is idempotent when the tag already exists', async () => {
      mockImagesGetByDigest.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });
      const res = await request(app).post('/api/storage/images/digest-abc/tags').send({ tag: 'nightly' });
      expect(res.status).toBe(200);
      expect(mockImagesUpdate).not.toHaveBeenCalled();
      expect(res.body.image.tags).toEqual(['nightly']);
    });

    it('adds a trimmed new tag', async () => {
      mockImagesGetByDigest.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });
      mockImagesUpdate.mockResolvedValue({ ...sampleImage, tags: ['nightly', 'v2'] });
      const res = await request(app).post('/api/storage/images/digest-abc/tags').send({ tag: '  v2  ' });
      expect(mockImagesUpdate).toHaveBeenCalledWith('digest-abc', { tags: ['nightly', 'v2'] });
      expect(res.body.image.tags).toEqual(['nightly', 'v2']);
    });

    it('500s when storage throws', async () => {
      mockImagesGetByDigest.mockRejectedValue(new Error('boom'));
      const res = await request(app).post('/api/storage/images/digest-abc/tags').send({ tag: 'x' });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/storage/images/:digest/tags/:tag', () => {
    it('404s when the image does not exist', async () => {
      mockImagesGetByDigest.mockResolvedValue(null);
      const res = await request(app).delete('/api/storage/images/nope/tags/x');
      expect(res.status).toBe(404);
    });

    it('removes the tag', async () => {
      mockImagesGetByDigest.mockResolvedValue({ ...sampleImage, tags: ['nightly', 'v2'] });
      mockImagesUpdate.mockResolvedValue({ ...sampleImage, tags: ['nightly'] });
      const res = await request(app).delete('/api/storage/images/digest-abc/tags/v2');
      expect(mockImagesUpdate).toHaveBeenCalledWith('digest-abc', { tags: ['nightly'] });
      expect(res.body.image.tags).toEqual(['nightly']);
    });

    it('500s when storage throws', async () => {
      mockImagesGetByDigest.mockRejectedValue(new Error('boom'));
      const res = await request(app).delete('/api/storage/images/digest-abc/tags/v2');
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/storage/images/:digest', () => {
    it('404s when the image does not exist', async () => {
      mockImagesDelete.mockResolvedValue({ deleted: false });
      const res = await request(app).delete('/api/storage/images/nope');
      expect(res.status).toBe(404);
    });

    it('deletes the image', async () => {
      mockImagesDelete.mockResolvedValue({ deleted: true });
      const res = await request(app).delete('/api/storage/images/digest-abc');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true });
    });

    it('500s when storage throws', async () => {
      mockImagesDelete.mockRejectedValue(new Error('boom'));
      const res = await request(app).delete('/api/storage/images/digest-abc');
      expect(res.status).toBe(500);
    });
  });
});
