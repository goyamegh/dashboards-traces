/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchChunked, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_CONCURRENT_CHUNKS } from '@/lib/chunkedFetch';

describe('fetchChunked', () => {
  it('returns an empty array for no ids without invoking the fetcher', async () => {
    const fetchChunk = jest.fn();
    const result = await fetchChunked([], 100, fetchChunk);
    expect(result).toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();
  });

  it('issues a single chunk for a small id list', async () => {
    const fetchChunk = jest.fn(async (chunk: string[]) => chunk);
    const result = await fetchChunked(['a', 'b'], 100, fetchChunk);
    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(result).toEqual(['a', 'b']);
  });

  it('splits ids into bounded chunks and flattens the results in chunk order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const fetchChunk = jest.fn(async (chunk: string[]) => chunk);

    const result = await fetchChunked(ids, 100, fetchChunk);

    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(fetchChunk.mock.calls[0][0]).toHaveLength(100);
    expect(fetchChunk.mock.calls[1][0]).toHaveLength(100);
    expect(fetchChunk.mock.calls[2][0]).toHaveLength(50);
    expect(result).toEqual(ids);
  });

  it('caps concurrent in-flight chunk requests at the configured max', async () => {
    const ids = Array.from({ length: 1600 }, (_, i) => `id-${i}`); // 16 chunks of 100
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchChunk = jest.fn(async (chunk: string[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
      return chunk;
    });

    await fetchChunked(ids, 100, fetchChunk);

    expect(fetchChunk).toHaveBeenCalledTimes(16);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT_CHUNKS);
  });

  it('honors a custom concurrency cap', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `id-${i}`); // 4 chunks of 100
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchChunk = jest.fn(async (chunk: string[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
      return chunk;
    });

    await fetchChunked(ids, 100, fetchChunk, 2);

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('propagates a chunk failure instead of swallowing it', async () => {
    const fetchChunk = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(fetchChunked(['a'], 100, fetchChunk)).rejects.toThrow('boom');
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CONCURRENT_CHUNKS).toBeGreaterThan(0);
  });
});
