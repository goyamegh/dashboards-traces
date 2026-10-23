/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import logsRoutes from '@/server/routes/logs';
import { fetchLogsLegacy } from '@/server/services/logsService';

// Mock the logs service (legacy proxy only — /api/logs goes through the observability module)
jest.mock('@/server/services/logsService', () => ({
  fetchLogsLegacy: jest.fn(),
}));

// Mock the observability module factory
jest.mock('@/server/services/observabilityClient', () => ({
  getObservabilityModule: jest.fn(),
}));
import { getObservabilityModule } from '@/server/services/observabilityClient';
const mockGetObservabilityModule = getObservabilityModule as jest.MockedFunction<typeof getObservabilityModule>;

// The module's logs.query — what the route calls.
const mockFetchLogs = jest.fn();
function moduleOf(type: 'opensearch' | 'cloudwatch' | 'file') {
  return {
    logs: { query: mockFetchLogs },
    traces: {} as any,
    metrics: {} as any,
    health: jest.fn(),
    isConfigured: () => true,
    describe: () => ({ type, target: 'x' }),
  } as any;
}
const mockFetchLogsLegacy = fetchLogsLegacy as jest.MockedFunction<typeof fetchLogsLegacy>;

// Helper to create mock request/response
function createMocks(body: any = {}, headers: Record<string, string> = {}) {
  const req = {
    body,
    headers,
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

describe('Logs Routes', () => {
  const originalEnv = process.env;


  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      OPENSEARCH_LOGS_ENDPOINT: 'http://localhost:9200',
      OPENSEARCH_LOGS_USERNAME: 'admin',
      OPENSEARCH_LOGS_PASSWORD: 'admin',
      OPENSEARCH_LOGS_INDEX: 'test-logs-*',
    };
    mockGetObservabilityModule.mockReturnValue(moduleOf('opensearch'));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('POST /api/logs', () => {
    it('should return logs from service', async () => {
      const logs = [{ timestamp: '2024-01-01', index: 'test-logs', message: 'Test log', level: 'info', source: 'test' }];
      const mockResult = { logs, total: 1 };
      mockFetchLogs.mockResolvedValue(mockResult);

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ runId: 'test-run-123' }));
      expect(res.json).toHaveBeenCalledWith({ logs, total: 1, backend: 'opensearch' });
    });

    it('should use default size of 100', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const { req, res } = createMocks({ runId: 'test' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ size: 100 }));
    });

    it('should accept custom size', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const { req, res } = createMocks({ runId: 'test', size: 50 });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ size: 50 }));
    });

    it('should pass query and time range filters (epoch ms, matching LogsQueryOptions.startTime/endTime: number and the epoch_millis range query)', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const startTime = new Date('2024-01-01T00:00:00Z').getTime();
      const endTime = new Date('2024-01-02T00:00:00Z').getTime();
      const { req, res } = createMocks({
        runId: 'test',
        query: 'error',
        startTime,
        endTime,
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({
          query: 'error',
          startTime,
          endTime,
        }));
    });

    it('should reject a non-numeric startTime with 400 (codex_review finding: previously untyped)', async () => {
      const { req, res } = createMocks({ runId: 'test', startTime: '2024-01-01T00:00:00Z' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject a non-numeric endTime with 400', async () => {
      const { req, res } = createMocks({ runId: 'test', endTime: 'not-a-number' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject a size of 0 with 400 (codex_review finding: previously unbounded)', async () => {
      const { req, res } = createMocks({ runId: 'test', size: 0 });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject a size above 1000 with 400', async () => {
      const { req, res } = createMocks({ runId: 'test', size: 5000 });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 503 when observability not configured', async () => {
      mockGetObservabilityModule.mockReturnValue(moduleOf('file'));

      const { req, res } = createMocks({ runId: 'test' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Observability data source not configured',
      });
    });

    it('should return 400 when body is empty (regression: previously ran an unscoped match-all query)', async () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('runId'),
      });
    });

    it('accepts a traceId as the scope when runId is absent (CloudWatch log correlation)', async () => {
      mockFetchLogs.mockResolvedValue({ logs: [], total: 0 });
      const { req, res } = createMocks({ traceId: 'a'.repeat(32), serviceName: 'svc' });
      await getRouteHandler(logsRoutes, 'post', '/api/logs')(req, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'a'.repeat(32), serviceName: 'svc' }));
    });

    it('should return 400 when runId is not a string', async () => {
      const { req, res } = createMocks({ runId: 12345 });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when body is not an object', async () => {
      const { req, res } = createMocks(null);
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when runId is whitespace-only (codex_review finding: falsy-only check let " " through)', async () => {
      const { req, res } = createMocks({ runId: '   ' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 500 on service error', async () => {
      mockFetchLogs.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ runId: 'test' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('Connection refused'),
      });
    });
  });

  describe('POST /api/opensearch/logs (legacy)', () => {
    it('should return 400 when endpoint is missing', async () => {
      const { req, res } = createMocks({
        indexPattern: 'logs-*',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('endpoint'),
      });
    });

    it('should return 400 when indexPattern is missing', async () => {
      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('indexPattern'),
      });
    });

    it('should return 400 when query is missing', async () => {
      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('query'),
      });
    });

    it('should call legacy logs service', async () => {
      const mockResult = { hits: { hits: [], total: 0 } };
      mockFetchLogsLegacy.mockResolvedValue(mockResult);

      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
        auth: { username: 'admin', password: 'admin' },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(mockFetchLogsLegacy).toHaveBeenCalledWith({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
        auth: { username: 'admin', password: 'admin' },
      });
      expect(res.json).toHaveBeenCalledWith(mockResult);
    });

    it('should return 500 on proxy error', async () => {
      mockFetchLogsLegacy.mockRejectedValue(new Error('Network error'));

      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('Network error'),
      });
    });
  });
});
