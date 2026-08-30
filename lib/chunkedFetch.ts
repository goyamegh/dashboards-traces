/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared "fetch a big id list without blowing up the request" policy.
 *
 * A comparison over a large multi-run pool can need results for hundreds of
 * ids (report ids, test-case ids, …) in one go. Two failure modes to avoid:
 *   - one unbounded `?ids=<all>` GET can blow past practical URL/header size
 *     limits (HTTP 431 — see asyncRunStorage.getReportsByIds's history);
 *   - firing one request per chunk with no cap can stampede the backend.
 *
 * `fetchChunked` splits `ids` into bounded chunks and fans them out with a
 * capped worker pool — never one unbounded request, never an unbounded burst
 * of parallel ones either. Used by asyncRunStorage (report ids) and
 * asyncTestCaseStorage (test-case ids).
 */
export const DEFAULT_CHUNK_SIZE = 100;
export const DEFAULT_MAX_CONCURRENT_CHUNKS = 8;

export async function fetchChunked<T>(
  ids: string[],
  chunkSize: number,
  fetchChunk: (chunk: string[]) => Promise<T[]>,
  maxConcurrentChunks: number = DEFAULT_MAX_CONCURRENT_CHUNKS
): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  const results: T[][] = new Array(chunks.length);
  let nextChunk = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextChunk++;
      if (i >= chunks.length) return;
      results[i] = await fetchChunk(chunks[i]);
    }
  }
  const workerCount = Math.min(maxConcurrentChunks, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.flat();
}
