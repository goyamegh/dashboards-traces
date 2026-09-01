/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the ApiClient methods added alongside content-addressed
 * benchmark images / benchmark doctor:
 *   listImages, getImage, tagImage, listEvaluationRuns, deleteBenchmark,
 *   updateEvaluationRun.
 */

import { ApiClient, ServerError } from '@/cli/utils/apiClient';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('ApiClient — benchmark images / doctor support', () => {
  const baseUrl = 'http://localhost:4001';
  let client: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new ApiClient(baseUrl);
  });

  describe('listImages', () => {
    it('fetches and returns the images array', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ images: [{ digest: 'd1' }], total: 1 }),
      });

      const result = await client.listImages();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/images`);
      expect(result).toEqual([{ digest: 'd1' }]);
    });

    it('returns [] when the response has no images field', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      const result = await client.listImages();
      expect(result).toEqual([]);
    });

    it('throws ServerError on a non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, statusText: 'Internal Server Error' });
      await expect(client.listImages()).rejects.toThrow(ServerError);
    });
  });

  describe('getImage', () => {
    it('fetches by digest and returns the parsed body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ image: { digest: 'd1' }, runs: [] }),
      });

      const result = await client.getImage('d1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/images/d1`);
      expect(result).toEqual({ image: { digest: 'd1' }, runs: [] });
    });

    it('URL-encodes the digest', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
      await client.getImage('digest/with/slash');
      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/images/digest%2Fwith%2Fslash`);
    });

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      const result = await client.getImage('missing');
      expect(result).toBeNull();
    });

    it('throws ServerError on other non-ok responses', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
      await expect(client.getImage('d1')).rejects.toThrow(ServerError);
    });
  });

  describe('tagImage', () => {
    it('POSTs the tag and returns the updated image', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ image: { digest: 'd1', tags: ['v2'] } }),
      });

      const result = await client.tagImage('d1', 'v2');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/images/d1/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'v2' }),
      });
      expect(result).toEqual({ digest: 'd1', tags: ['v2'] });
    });

    it('throws ServerError on a non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, statusText: 'Bad Request' });
      await expect(client.tagImage('d1', 'v2')).rejects.toThrow(ServerError);
    });
  });

  describe('listEvaluationRuns', () => {
    it('defaults size to 500 with no filters', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ evaluationRuns: [] }) });
      await client.listEvaluationRuns();
      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/evaluation-runs?size=500`);
    });

    it('includes benchmarkId, imageDigest and a custom size', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ evaluationRuns: [{ id: 'r1' }] }) });
      const result = await client.listEvaluationRuns({ benchmarkId: 'b1', imageDigest: 'd1', size: 10 });

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(calledUrl.searchParams.get('benchmarkId')).toBe('b1');
      expect(calledUrl.searchParams.get('imageDigest')).toBe('d1');
      expect(calledUrl.searchParams.get('size')).toBe('10');
      expect(result).toEqual([{ id: 'r1' }]);
    });

    it('returns [] when evaluationRuns is missing from the response', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      const result = await client.listEvaluationRuns();
      expect(result).toEqual([]);
    });

    it('throws ServerError on a non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, statusText: 'Internal Server Error' });
      await expect(client.listEvaluationRuns()).rejects.toThrow(ServerError);
    });
  });

  describe('deleteBenchmark', () => {
    it('DELETEs the benchmark and returns true on success', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const result = await client.deleteBenchmark('bench-1');
      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks/bench-1`, { method: 'DELETE' });
      expect(result).toBe(true);
    });

    it('URL-encodes the id and returns false on failure (no throw)', async () => {
      mockFetch.mockResolvedValue({ ok: false });
      const result = await client.deleteBenchmark('bench/1');
      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks/bench%2F1`, { method: 'DELETE' });
      expect(result).toBe(false);
    });
  });

  describe('updateEvaluationRun', () => {
    it('PUTs the updates and returns the updated run', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ evaluationRun: { id: 'run-1', benchmarkId: 'b2' } }),
      });

      const result = await client.updateEvaluationRun('run-1', { benchmarkId: 'b2' } as any);

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/evaluation-runs/run-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarkId: 'b2' }),
      });
      expect(result).toEqual({ id: 'run-1', benchmarkId: 'b2' });
    });

    it('falls back to the raw body when evaluationRun is absent', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'run-1' }) });
      const result = await client.updateEvaluationRun('run-1', {} as any);
      expect(result).toEqual({ id: 'run-1' });
    });

    it('returns null on a non-ok response (no throw)', async () => {
      mockFetch.mockResolvedValue({ ok: false });
      const result = await client.updateEvaluationRun('run-1', {} as any);
      expect(result).toBeNull();
    });
  });
});
