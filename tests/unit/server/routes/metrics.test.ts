/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import metricsRoutes from '@/server/routes/metrics';
import { computeAggregateMetrics } from '@/server/services/metricsService';

// Mock the metrics service (only the helpers the route still calls directly).
jest.mock('@/server/services/metricsService', () => ({
  computeMetricsFromSampleSpans: jest.fn().mockReturnValue(null),
  computeAggregateMetrics: jest.fn(),
}));

// Route now goes through the observability MODULE (not the raw client).
jest.mock('@/server/services/observabilityClient', () => ({
  getObservabilityModule: jest.fn(),
}));
import { getObservabilityModule } from '@/server/services/observabilityClient';
const mockGetObservabilityModule = getObservabilityModule as jest.MockedFunction<typeof getObservabilityModule>;
const mockComputeAggregateMetrics = computeAggregateMetrics as jest.MockedFunction<typeof computeAggregateMetrics>;

const NO_METRICS_MSG = 'Trace-derived metrics require an OpenSearch observability cluster';

/** Build a fake IObservabilityModule whose metrics ops are jest mocks. */
function fakeModule(opts: { supported?: boolean; computeForRun?: jest.Mock; computeForRuns?: jest.Mock; computeOverview?: jest.Mock } = {}) {
  return {
    traces: {} as any,
    logs: {} as any,
    metrics: {
      supported: opts.supported ?? true,
      computeForRun: opts.computeForRun ?? jest.fn(),
      computeForRuns: opts.computeForRuns ?? jest.fn(),
      computeOverview: opts.computeOverview ?? jest.fn(),
    },
    health: jest.fn(),
    isConfigured: () => true,
  } as any;
}

function createMocks(params: any = {}, body: any = {}, headers: any = {}) {
  const req = { params, body, headers } as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function getRouteHandler(router: any, method: string, path: string) {
  const route = router.stack.find(
    (layer: any) => layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Metrics Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetObservabilityModule.mockReturnValue(fakeModule());
  });

  describe('GET /api/metrics/overview', () => {
    it('returns the agent overview when the backend supports metrics', async () => {
      const overview = { window: { startTime: 1, endTime: 2 }, sampledSpans: 2, capped: false, services: [{ service: 'claude-code-agent', llmCalls: 1 }], totals: { services: 1 } };
      const computeOverview = jest.fn().mockResolvedValue(overview);
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeOverview }));

      const { req, res } = createMocks({}, {}, {});
      (req as any).query = { hours: '24' };
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/overview');
      await handler(req, res);

      expect(computeOverview).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(overview);
    });

    it('returns 503 when the backend does not support metrics (file backend)', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ supported: false }));
      const { req, res } = createMocks({}, {}, {});
      (req as any).query = {};
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/overview');
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('GET /api/metrics/:runId', () => {
    it('computes metrics for a run via the observability module', async () => {
      const mockMetrics = {
        runId: 'test-run-123', traceId: 'trace-123', totalTokens: 1000, inputTokens: 800,
        outputTokens: 200, llmCalls: 3, toolCalls: 5, toolsUsed: ['search', 'query'],
        costUsd: 0.05, durationMs: 5000, status: 'success' as const,
      };
      const computeForRun = jest.fn().mockResolvedValue(mockMetrics);
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeForRun }));

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');
      await handler(req, res);

      expect(computeForRun).toHaveBeenCalledWith('test-run-123');
      expect(res.json).toHaveBeenCalledWith(mockMetrics);
    });

    it('returns 503 when the backend does not support metrics (file backend)', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ supported: false }));

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: NO_METRICS_MSG });
    });

    it('returns 503 when computeForRun yields null', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeForRun: jest.fn().mockResolvedValue(null) }));

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns 500 on service error', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeForRun: jest.fn().mockRejectedValue(new Error('Trace not found')) }));

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Trace not found' });
    });
  });

  describe('POST /api/metrics/batch', () => {
    it('computes metrics for multiple runs via the module', async () => {
      const m1 = { runId: 'run-1', totalTokens: 500, status: 'success' as const } as any;
      const m2 = { runId: 'run-2', totalTokens: 800, status: 'success' as const } as any;
      const computeForRuns = jest.fn().mockResolvedValue([m1, m2]);
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeForRuns }));
      const mockAggregate = { totalRuns: 2 } as any;
      mockComputeAggregateMetrics.mockReturnValue(mockAggregate);

      const { req, res } = createMocks({}, { runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);

      expect(computeForRuns).toHaveBeenCalledWith(['run-1', 'run-2']);
      expect(mockComputeAggregateMetrics).toHaveBeenCalledWith([m1, m2]);
      expect(res.json).toHaveBeenCalledWith({ metrics: [m1, m2], aggregate: mockAggregate });
    });

    it('returns 400 when runIds is not an array', async () => {
      const { req, res } = createMocks({}, { runIds: 'not-an-array' });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'runIds must be an array' });
    });

    it('returns per-run errors when the backend does not support metrics', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ supported: false }));
      mockComputeAggregateMetrics.mockReturnValue({ totalRuns: 0 } as any);

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [expect.objectContaining({ runId: 'run-1', error: NO_METRICS_MSG, status: 'error' })],
      }));
    });

    it('handles batch failure gracefully', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({ computeForRuns: jest.fn().mockRejectedValue(new Error('OpenSearch connection failed')) }));
      mockComputeAggregateMetrics.mockReturnValue({ totalRuns: 0 } as any);

      const { req, res } = createMocks({}, { runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [
          expect.objectContaining({ runId: 'run-1', error: 'OpenSearch connection failed', status: 'error' }),
          expect.objectContaining({ runId: 'run-2', error: 'OpenSearch connection failed', status: 'error' }),
        ],
      }));
    });

    it('returns per-run errors when computeForRuns throws synchronously', async () => {
      mockGetObservabilityModule.mockReturnValue(fakeModule({
        computeForRuns: jest.fn().mockImplementation(() => { throw new Error('Unexpected error'); }),
      }));
      mockComputeAggregateMetrics.mockReturnValue({ totalRuns: 0 } as any);

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [expect.objectContaining({ runId: 'run-1', error: 'Unexpected error', status: 'error' })],
      }));
    });
  });
});
