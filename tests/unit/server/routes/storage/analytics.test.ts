/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import analyticsRoutes from '@/server/routes/storage/analytics';
import { getStorageModule } from '@/server/adapters/index';

// Mock the adapters module
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(),
}));

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    query,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Analytics Storage Routes', () => {
  let mockStorage: {
    isConfigured: jest.Mock;
    analytics: {
      query: jest.Mock;
      aggregations: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage = {
      isConfigured: jest.fn().mockReturnValue(true),
      analytics: {
        query: jest.fn(),
        aggregations: jest.fn(),
      },
    };
    (getStorageModule as jest.Mock).mockReturnValue(mockStorage);
  });

  describe('GET /api/storage/analytics', () => {
    it('should return records with no filters', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [
          { id: 'analytics-1', experimentId: 'exp-1' },
          { id: 'analytics-2', experimentId: 'exp-2' },
        ],
        total: 2,
      });

      const { req, res } = createMocks({}, {}, {});
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith({}, { size: 1000, from: 0 });
      expect(res.json).toHaveBeenCalledWith({
        records: [
          { id: 'analytics-1', experimentId: 'exp-1' },
          { id: 'analytics-2', experimentId: 'exp-2' },
        ],
        total: 2,
      });
    });

    it('should apply experimentId filter', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [{ id: 'analytics-1', experimentId: 'exp-1' }],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { experimentId: 'exp-1' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith(
        { experimentId: 'exp-1' },
        { size: 1000, from: 0 }
      );
    });

    it('should apply multiple filters', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {}, {
        experimentId: 'exp-1',
        testCaseId: 'tc-1',
        agentId: 'agent-1',
        modelId: 'model-1',
        passFailStatus: 'passed',
      });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith(
        {
          experimentId: 'exp-1',
          testCaseId: 'tc-1',
          agentId: 'agent-1',
          modelId: 'model-1',
          passFailStatus: 'passed',
        },
        { size: 1000, from: 0 }
      );
    });

    it('should respect pagination params', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {}, { size: '50', from: '100' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith({}, { size: 50, from: 100 });
    });

    it('should return empty results when storage is not configured', async () => {
      mockStorage.isConfigured.mockReturnValue(false);

      const { req, res } = createMocks();
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockStorage.analytics.query).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ records: [], total: 0 });
    });

    it('should handle errors', async () => {
      mockStorage.analytics.query.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Connection refused' });
    });
  });

  describe('GET /api/storage/analytics/aggregations', () => {
    it('should return aggregations grouped by agentId by default', async () => {
      const aggregationsResult = {
        aggregations: [
          {
            key: 'agent-1',
            metrics: {
              avgAccuracy: 0.85,
              avgFaithfulness: 0.9,
            },
            passCount: 10,
            failCount: 2,
            totalRuns: 12,
          },
        ],
        groupBy: 'agentId',
      };
      mockStorage.analytics.aggregations.mockResolvedValue(aggregationsResult);

      const { req, res } = createMocks({}, {}, {});
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(mockStorage.analytics.aggregations).toHaveBeenCalledWith(undefined, 'agentId');
      expect(res.json).toHaveBeenCalledWith(aggregationsResult);
    });

    it('should use custom groupBy', async () => {
      mockStorage.analytics.aggregations.mockResolvedValue({
        aggregations: [],
        groupBy: 'modelId',
      });

      const { req, res } = createMocks({}, {}, { groupBy: 'modelId' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(mockStorage.analytics.aggregations).toHaveBeenCalledWith(undefined, 'modelId');
    });

    it('should apply experimentId filter to aggregations', async () => {
      mockStorage.analytics.aggregations.mockResolvedValue({
        aggregations: [],
        groupBy: 'agentId',
      });

      const { req, res } = createMocks({}, {}, { experimentId: 'exp-1' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(mockStorage.analytics.aggregations).toHaveBeenCalledWith('exp-1', 'agentId');
    });

    it('should return empty results when storage is not configured', async () => {
      mockStorage.isConfigured.mockReturnValue(false);

      const { req, res } = createMocks({}, {}, { groupBy: 'modelId' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(mockStorage.analytics.aggregations).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ aggregations: [], groupBy: 'modelId' });
    });

    it('should handle errors', async () => {
      mockStorage.analytics.aggregations.mockRejectedValue(new Error('Aggregation failed'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /api/storage/analytics/search', () => {
    it('should search with custom filters', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [{ id: 'analytics-1' }],
        total: 1,
      });

      const { req, res } = createMocks({}, {
        filters: { experimentId: 'exp-1', passFailStatus: 'passed' },
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith(
        { experimentId: 'exp-1', passFailStatus: 'passed' },
        { size: 1000, from: 0 }
      );
      expect(res.json).toHaveBeenCalledWith({
        records: [{ id: 'analytics-1' }],
        total: 1,
        aggregations: {},
      });
    });

    it('should handle array filters', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {
        filters: { agentId: ['agent-1', 'agent-2'] },
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith(
        { agentId: ['agent-1', 'agent-2'] },
        { size: 1000, from: 0 }
      );
    });

    it('should respect pagination params from body', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {
        filters: {},
        size: 50,
        from: 100,
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith({}, { size: 50, from: 100 });
    });

    it('should use empty filters when no filters provided', async () => {
      mockStorage.analytics.query.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {});
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(mockStorage.analytics.query).toHaveBeenCalledWith({}, { size: 1000, from: 0 });
      expect(res.json).toHaveBeenCalledWith({
        records: [],
        total: 0,
        aggregations: {},
      });
    });

    it('should return empty results when storage is not configured', async () => {
      mockStorage.isConfigured.mockReturnValue(false);

      const { req, res } = createMocks({}, { filters: {} });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(mockStorage.analytics.query).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ records: [], total: 0, aggregations: {} });
    });

    it('should handle errors', async () => {
      mockStorage.analytics.query.mockRejectedValue(new Error('Search failed'));

      const { req, res } = createMocks({}, { filters: {} });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
