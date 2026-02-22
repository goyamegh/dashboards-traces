/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';

// Create mock storage module
const mockStorage = {
  isConfigured: jest.fn().mockReturnValue(true),
  benchmarks: { getById: jest.fn() },
  runs: { getById: jest.fn() },
};

// Mock the storage adapter
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(() => mockStorage),
}));

import { getStorageModule } from '@/server/adapters/index';
import reportsRoutes from '@/server/routes/storage/reports';

// Mock sample benchmarks
jest.mock('@/cli/demo/sampleBenchmarks', () => ({
  SAMPLE_BENCHMARKS: [
    {
      id: 'demo-bench-1',
      name: 'Sample Benchmark',
      description: 'A sample benchmark',
      testCaseIds: ['demo-tc-1'],
      runs: [
        {
          id: 'demo-run-1',
          name: 'Demo Run',
          agentKey: 'mock',
          modelId: 'claude-sonnet',
          status: 'completed',
          results: { 'demo-tc-1': { reportId: 'demo-report-1', status: 'completed' } },
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
  isSampleBenchmarkId: (id: string) => id.startsWith('demo-'),
}));

// Mock sample runs (reports)
jest.mock('@/cli/demo/sampleRuns', () => ({
  SAMPLE_RUNS: [
    {
      id: 'demo-report-1',
      testCaseId: 'demo-tc-1',
      timestamp: '2024-01-01T00:00:00Z',
      agentName: 'Mock',
      modelName: 'Sonnet',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [{ id: 's1', timestamp: 1, type: 'response', content: 'Answer' }],
      metrics: { accuracy: 90 },
      llmJudgeReasoning: 'Great',
    },
  ],
}));

// Mock the report formatter registry and collectReportData
// Note: jest.mock is hoisted, so all values must be defined inline
jest.mock('@/services/report/server', () => {
  const mockJsonGenerate = jest.fn().mockResolvedValue({
    content: '{"test": true}',
    mimeType: 'application/json',
    filename: 'report.json',
  });
  const mockHtmlGenerate = jest.fn().mockResolvedValue({
    content: '<html></html>',
    mimeType: 'text/html',
    filename: 'report.html',
  });

  const registryMap = new Map();
  registryMap.set('json', {
    format: 'json',
    name: 'JSON',
    extension: 'json',
    generate: mockJsonGenerate,
  });
  registryMap.set('html', {
    format: 'html',
    name: 'HTML',
    extension: 'html',
    generate: mockHtmlGenerate,
  });

  return {
    reportFormatterRegistry: {
      has: (f: string) => registryMap.has(f),
      get: (f: string) => registryMap.get(f),
      getSupportedFormats: () => Array.from(registryMap.keys()),
    },
    collectReportData: jest.fn().mockReturnValue({
      benchmark: { id: 'bench-1', name: 'Test', testCaseCount: 1 },
      runs: [],
      comparisonRows: [],
      reports: {},
      generatedAt: '2024-01-01T00:00:00Z',
      generatedBy: 'api',
    }),
  };
});

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
function createMocks(params: any = {}, query: any = {}) {
  const req = {
    params,
    query,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    send: jest.fn(),
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

describe('Reports Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.isConfigured.mockReturnValue(true);
    mockStorage.benchmarks.getById.mockResolvedValue(null);
    mockStorage.runs.getById.mockResolvedValue(null);
  });

  describe('GET /api/storage/benchmarks/:id/report', () => {
    const handler = getRouteHandler(reportsRoutes, 'get', '/api/storage/benchmarks/:id/report');

    it('should return 400 for unsupported format', async () => {
      const { req, res } = createMocks({ id: 'demo-bench-1' }, { format: 'csv' });
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Unsupported format') })
      );
    });

    it('should return 404 for non-existent benchmark', async () => {
      mockStorage.benchmarks.getById.mockResolvedValue(null);
      const { req, res } = createMocks({ id: 'non-existent' }, { format: 'json' });
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Benchmark not found' })
      );
    });

    it('should generate report for sample benchmark', async () => {
      const { req, res } = createMocks({ id: 'demo-bench-1' }, { format: 'json' });
      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('attachment')
      );
      expect(res.send).toHaveBeenCalled();
    });

    it('should use default format json when not specified', async () => {
      const { req, res } = createMocks({ id: 'demo-bench-1' }, {});
      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(res.send).toHaveBeenCalled();
    });

    it('should filter runs by runIds query parameter', async () => {
      const { req, res } = createMocks(
        { id: 'demo-bench-1' },
        { format: 'json', runIds: 'demo-run-1' }
      );
      await handler(req, res);

      expect(res.send).toHaveBeenCalled();
    });

    it('should return 400 when runIds matches no runs', async () => {
      const { req, res } = createMocks(
        { id: 'demo-bench-1' },
        { format: 'json', runIds: 'non-existent-run' }
      );
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('No matching runs') })
      );
    });

    it('should generate HTML report', async () => {
      const { req, res } = createMocks({ id: 'demo-bench-1' }, { format: 'html' });
      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(res.send).toHaveBeenCalled();
    });

    it('should fetch benchmark from storage when not sample', async () => {
      mockStorage.benchmarks.getById.mockResolvedValue({
        id: 'real-bench-1',
        name: 'Real Benchmark',
        testCaseIds: ['tc-1'],
        runs: [
          {
            id: 'real-run-1',
            name: 'Real Run',
            agentKey: 'agent',
            modelId: 'model',
            status: 'completed',
            results: { 'tc-1': { reportId: 'real-report-1', status: 'completed' } },
            createdAt: '2024-02-01T00:00:00Z',
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
      });

      mockStorage.runs.getById.mockResolvedValue({
        id: 'real-report-1',
        testCaseId: 'tc-1',
        status: 'completed',
        passFailStatus: 'passed',
        metrics: { accuracy: 80 },
      });

      const { req, res } = createMocks({ id: 'real-bench-1' }, { format: 'json' });
      await handler(req, res);

      expect(mockStorage.benchmarks.getById).toHaveBeenCalledWith('real-bench-1');
      expect(res.send).toHaveBeenCalled();
    });

    it('should return 400 when formatter throws puppeteer error', async () => {
      // Override the mock to simulate pdf format with puppeteer error
      const { reportFormatterRegistry, collectReportData } = require('@/services/report/server');
      const mockPdfGenerate = jest.fn().mockRejectedValue(
        new Error('PDF generation requires puppeteer. Install it with: npm install puppeteer')
      );
      reportFormatterRegistry.has = (f: string) => f === 'pdf' || f === 'json' || f === 'html';
      reportFormatterRegistry.get = (f: string) => {
        if (f === 'pdf') return { format: 'pdf', name: 'PDF', extension: 'pdf', generate: mockPdfGenerate };
        return reportFormatterRegistry.get(f);
      };

      const { req, res } = createMocks({ id: 'demo-bench-1' }, { format: 'pdf' });
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('puppeteer') })
      );
    });

    it('should handle storage error gracefully and return 404', async () => {
      mockStorage.benchmarks.getById.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ id: 'missing-bench' }, { format: 'json' });
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
