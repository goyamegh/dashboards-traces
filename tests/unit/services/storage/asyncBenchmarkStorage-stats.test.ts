/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for asyncBenchmarkStorage stats refresh methods
 */

import { jest } from '@jest/globals';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('AsyncBenchmarkStorage Stats Refresh', () => {
  let asyncBenchmarkStorage: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Dynamically import to use mocked fetch
    const module = await import('@/services/storage/asyncBenchmarkStorage');
    asyncBenchmarkStorage = module.asyncBenchmarkStorage;
  });

  describe('refreshAllStats', () => {
    it('should call refresh-all-stats endpoint and return count', async () => {
      const benchmarkId = 'bench-123';
      const expectedResponse = { refreshed: 5 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => expectedResponse,
      });

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toEqual(expectedResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/storage/benchmarks/${benchmarkId}/refresh-all-stats`,
        { method: 'POST' }
      );
    });

    it('should return null on fetch error', async () => {
      const benchmarkId = 'bench-456';

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });

    it('should return null on non-ok response', async () => {
      const benchmarkId = 'bench-789';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Benchmark not found' }),
      });

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });

    it('should handle 404 errors gracefully', async () => {
      const benchmarkId = 'non-existent';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Benchmark not found' }),
      });

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });
  });

  describe('refreshRunStats', () => {
    it('should call refresh-stats endpoint for specific run', async () => {
      const benchmarkId = 'bench-123';
      const runId = 'run-456';
      const expectedResponse = {
        refreshed: true,
        runId: 'run-456',
        stats: { passed: 5, failed: 2, pending: 0, total: 7 },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => expectedResponse,
      });

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(result).toEqual(expectedResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/storage/benchmarks/${benchmarkId}/runs/${runId}/refresh-stats`,
        { method: 'POST' }
      );
    });

    it('should return null on fetch error', async () => {
      const benchmarkId = 'bench-123';
      const runId = 'run-456';

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(result).toBeNull();
    });

    it('should return null on non-ok response', async () => {
      const benchmarkId = 'bench-123';
      const runId = 'run-456';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Run not found' }),
      });

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(result).toBeNull();
    });

    it('should handle 404 for non-existent run', async () => {
      const benchmarkId = 'bench-123';
      const runId = 'non-existent';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Run not found in benchmark' }),
      });

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(result).toBeNull();
    });

    it('should return stats object with correct structure', async () => {
      const benchmarkId = 'bench-123';
      const runId = 'run-789';
      const expectedStats = { passed: 10, failed: 3, pending: 2, total: 15 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          refreshed: true,
          runId,
          stats: expectedStats,
        }),
      });

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(result).not.toBeNull();
      expect(result!.stats).toEqual(expectedStats);
      expect(result!.stats.passed).toBe(10);
      expect(result!.stats.failed).toBe(3);
      expect(result!.stats.pending).toBe(2);
      expect(result!.stats.total).toBe(15);
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle server 500 errors gracefully', async () => {
      const benchmarkId = 'bench-500';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' }),
      });

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });

    it('should handle malformed JSON responses', async () => {
      const benchmarkId = 'bench-bad-json';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Invalid JSON');
        },
      } as any);

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });

    it('should handle timeout errors', async () => {
      const benchmarkId = 'bench-timeout';

      mockFetch.mockRejectedValueOnce(new Error('Request timeout'));

      const result = await asyncBenchmarkStorage.refreshAllStats(benchmarkId);

      expect(result).toBeNull();
    });

    it('should work with special characters in IDs', async () => {
      const benchmarkId = 'bench-with-special-chars-@#$';
      const runId = 'run-with-special-chars-!%^';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ refreshed: true, runId, stats: {} }),
      });

      const result = await asyncBenchmarkStorage.refreshRunStats(benchmarkId, runId);

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/storage/benchmarks/${benchmarkId}/runs/${runId}/refresh-stats`,
        { method: 'POST' }
      );
    });
  });

  describe('Integration with existing methods', () => {
    it('should not interfere with getById', async () => {
      const benchmarkId = 'bench-123';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: benchmarkId,
          name: 'Test Benchmark',
          runs: [],
        }),
      });

      // This should use the opensearchClient mock, not our refresh methods
      // Just verifying the methods exist and don't break existing functionality
      const storage = asyncBenchmarkStorage;
      expect(storage.refreshAllStats).toBeDefined();
      expect(storage.refreshRunStats).toBeDefined();
      expect(storage.getById).toBeDefined();
    });
  });
});
