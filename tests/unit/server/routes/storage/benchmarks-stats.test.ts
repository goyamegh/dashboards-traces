/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for benchmark stats backfill and refresh functionality
 */

import { jest } from '@jest/globals';

// Mock dependencies
const mockGet = jest.fn();
const mockSearch = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    get: mockGet,
    search: mockSearch,
    update: mockUpdate,
  })),
}));

jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn().mockReturnValue(true),
  requireStorageClient: jest.fn().mockReturnValue({
    get: mockGet,
    search: mockSearch,
    update: mockUpdate,
  }),
  INDEXES: {
    benchmarks: 'evals_benchmarks',
    runs: 'evals_runs',
  },
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import request from 'supertest';
import type { Application } from 'express';
import type { BenchmarkRun, RunStats } from '@/types';

describe('Benchmark Stats Backfill', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    app = express();
    app.use(express.json());

    // We'll dynamically import the router after mocks are set up
  });

  describe('Stale Stats Detection', () => {
    it('should detect runs with missing stats', async () => {
      const runWithoutStats: Partial<BenchmarkRun> = {
        id: 'run-1',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
        // stats is missing
      };

      const benchmarkData = {
        id: 'bench-1',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithoutStats],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
              { _source: { id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' } },
            ],
          },
        },
      });

      mockUpdate.mockResolvedValueOnce({ body: {} });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-1');

      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats).toBeDefined();
      expect(response.body.runs[0].stats.passed).toBe(1);
      expect(response.body.runs[0].stats.failed).toBe(1);
      expect(response.body.runs[0].stats.pending).toBe(0);
    });

    it('should detect runs with stale stats (pending > 0 when all completed)', async () => {
      const runWithStaleStats: Partial<BenchmarkRun> = {
        id: 'run-2',
        status: 'completed',
        stats: { passed: 1, failed: 0, pending: 1, total: 2 }, // STALE: shows 1 pending
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Actually completed
        },
      };

      const benchmarkData = {
        id: 'bench-2',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithStaleStats],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
              { _source: { id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' } },
            ],
          },
        },
      });

      mockUpdate.mockResolvedValueOnce({ body: {} });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-2');

      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats).toBeDefined();
      expect(response.body.runs[0].stats.passed).toBe(2);
      expect(response.body.runs[0].stats.failed).toBe(0);
      expect(response.body.runs[0].stats.pending).toBe(0); // Fixed!
    });

    it('should NOT backfill runs with correct stats', async () => {
      const runWithCorrectStats: Partial<BenchmarkRun> = {
        id: 'run-3',
        status: 'completed',
        stats: { passed: 2, failed: 0, pending: 0, total: 2 }, // Correct
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      };

      const benchmarkData = {
        id: 'bench-3',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithCorrectStats],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-3');

      expect(response.status).toBe(200);
      // Should NOT call update since stats are correct
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should handle trace-mode pending reports correctly', async () => {
      const runWithPendingTrace: Partial<BenchmarkRun> = {
        id: 'run-4',
        status: 'completed',
        stats: { passed: 1, failed: 0, pending: 1, total: 2 }, // Correct (1 still pending traces)
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Completed but traces pending
        },
      };

      const benchmarkData = {
        id: 'bench-4',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithPendingTrace],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
              { _source: { id: 'report-2', passFailStatus: undefined, metricsStatus: 'pending' } }, // Still pending
            ],
          },
        },
      });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-4');

      expect(response.status).toBe(200);
      // Stats should remain correct (1 pending)
      expect(response.body.runs[0].stats.pending).toBe(1);
    });
  });

  describe('Manual Stats Refresh Endpoints', () => {
    describe('POST /api/storage/benchmarks/:id/refresh-all-stats', () => {
      it('should refresh stats for all runs in benchmark', async () => {
        const benchmarkData = {
          id: 'bench-5',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [
            {
              id: 'run-1',
              status: 'completed',
              stats: { passed: 0, failed: 0, pending: 2, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: 'report-2', status: 'completed' },
              },
            },
            {
              id: 'run-2',
              status: 'completed',
              stats: { passed: 1, failed: 0, pending: 1, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-3', status: 'completed' },
                'tc-2': { reportId: 'report-4', status: 'completed' },
              },
            },
          ],
        };

        mockGet.mockResolvedValueOnce({
          body: {
            found: true,
            _source: benchmarkData,
          },
        });

        // Mock reports for run-1
        mockSearch.mockResolvedValueOnce({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
                { _source: { id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' } },
              ],
            },
          },
        });

        // Mock reports for run-2
        mockSearch.mockResolvedValueOnce({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-3', passFailStatus: 'passed', metricsStatus: 'ready' } },
                { _source: { id: 'report-4', passFailStatus: 'failed', metricsStatus: 'ready' } },
              ],
            },
          },
        });

        mockUpdate.mockResolvedValue({ body: {} });

        const router = await import('@/server/routes/storage/benchmarks');
        app.use('/api/storage', router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-5/refresh-all-stats');

        expect(response.status).toBe(200);
        expect(response.body.refreshed).toBe(2); // Both runs refreshed
        expect(mockUpdate).toHaveBeenCalledTimes(2); // Once per run
      });

      it('should return 404 for non-existent benchmark', async () => {
        mockGet.mockResolvedValueOnce({
          body: {
            found: false,
          },
        });

        const router = await import('@/server/routes/storage/benchmarks');
        app.use('/api/storage', router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/non-existent/refresh-all-stats');

        expect(response.status).toBe(404);
        expect(response.body.error).toContain('not found');
      });
    });

    describe('POST /api/storage/benchmarks/:id/runs/:runId/refresh-stats', () => {
      it('should refresh stats for specific run', async () => {
        const benchmarkData = {
          id: 'bench-6',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [
            {
              id: 'run-target',
              status: 'completed',
              stats: { passed: 0, failed: 0, pending: 2, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: 'report-2', status: 'completed' },
              },
            },
            {
              id: 'run-other',
              status: 'completed',
              stats: { passed: 1, failed: 1, pending: 0, total: 2 }, // Correct
              results: {
                'tc-1': { reportId: 'report-3', status: 'completed' },
                'tc-2': { reportId: 'report-4', status: 'completed' },
              },
            },
          ],
        };

        mockGet.mockResolvedValueOnce({
          body: {
            found: true,
            _source: benchmarkData,
          },
        });

        mockSearch.mockResolvedValueOnce({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
                { _source: { id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' } },
              ],
            },
          },
        });

        mockUpdate.mockResolvedValueOnce({ body: {} });

        const router = await import('@/server/routes/storage/benchmarks');
        app.use('/api/storage', router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-6/runs/run-target/refresh-stats');

        expect(response.status).toBe(200);
        expect(response.body.refreshed).toBe(true);
        expect(response.body.runId).toBe('run-target');
        expect(response.body.stats).toEqual({
          passed: 1,
          failed: 1,
          pending: 0,
          total: 2,
        });
        expect(mockUpdate).toHaveBeenCalledTimes(1); // Only target run updated
      });

      it('should return 404 for non-existent run', async () => {
        const benchmarkData = {
          id: 'bench-7',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1'],
          runs: [
            {
              id: 'run-exists',
              status: 'completed',
              results: {},
            },
          ],
        };

        mockGet.mockResolvedValueOnce({
          body: {
            found: true,
            _source: benchmarkData,
          },
        });

        const router = await import('@/server/routes/storage/benchmarks');
        app.use('/api/storage', router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-7/runs/non-existent/refresh-stats');

        expect(response.status).toBe(404);
        expect(response.body.error).toContain('not found');
      });
    });
  });

  describe('Stats Computation Logic', () => {
    it('should correctly count passed/failed/pending from reports', async () => {
      const run: Partial<BenchmarkRun> = {
        id: 'run-test',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
          'tc-4': { reportId: 'report-4', status: 'completed' },
        },
      };

      const benchmarkData = {
        id: 'bench-test',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3', 'tc-4'],
        runs: [run],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
              { _source: { id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' } },
              { _source: { id: 'report-3', passFailStatus: undefined, metricsStatus: 'pending' } },
              { _source: { id: 'report-4', passFailStatus: 'passed', metricsStatus: 'ready' } },
            ],
          },
        },
      });

      mockUpdate.mockResolvedValueOnce({ body: {} });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-test');

      expect(response.status).toBe(200);
      const stats = response.body.runs[0].stats;
      expect(stats.passed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(4);
    });

    it('should handle failed/cancelled results correctly', async () => {
      const run: Partial<BenchmarkRun> = {
        id: 'run-test2',
        status: 'cancelled',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'failed' }, // Execution failed
          'tc-3': { reportId: 'report-3', status: 'cancelled' }, // Cancelled
        },
      };

      const benchmarkData = {
        id: 'bench-test2',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
        runs: [run],
      };

      mockGet.mockResolvedValueOnce({
        body: {
          found: true,
          _source: benchmarkData,
        },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' } },
            ],
          },
        },
      });

      mockUpdate.mockResolvedValueOnce({ body: {} });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use('/api/storage', router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-test2');

      expect(response.status).toBe(200);
      const stats = response.body.runs[0].stats;
      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(2); // failed + cancelled count as failed
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
    });
  });
});
