/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test pinning the fix for: the legacy
 * `POST /api/storage/benchmarks/:id/execute` path (the CLI's
 * `benchmark -f test-cases.json` / `benchmark -n "Existing Benchmark"`
 * flow, and the BenchmarkRunsPage "Configure Run" dialog) never stamped
 * `imageDigest` on the resulting BenchmarkRun — only the unified
 * `POST /api/storage/evaluation-runs` path did. That silently excluded
 * every legacy-path run from the content-addressed image/dedup story
 * (`benchmark doctor --migrate-images`, image-scoped run comparisons).
 *
 * Asserts:
 *   - the persisted BenchmarkRun carries a real (sha256-hex-shaped)
 *     `imageDigest`;
 *   - the corresponding image doc actually exists (find-or-create worked,
 *     not just a field slapped on the run with nothing backing it);
 *   - re-executing against the SAME test-case content produces the SAME
 *     digest (content-addressed identity — the whole point of the feature).
 *
 * Sister coverage:
 *   - tests/integration/server/adapters/benchmarkImages.integration.test.ts —
 *     the unified evaluation-runs path's imageDigest stamping.
 *   - tests/integration/cli/benchmarkDoctor.integration.test.ts —
 *     `benchmark doctor --migrate-images` converting benchmarks into images.
 *
 * Same OpenSearch-required self-skip pattern as
 * benchmarkExecuteEvaluator.integration.test.ts (this route hard-requires
 * requireStorageClient(); file storage alone 400s).
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=benchmarkExecuteImageDigest.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();
const SHA256_HEX = /^[a-f0-9]{64}$/;

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    if (!r.ok) return false;
    const data = await r.json();
    if (data.backend === 'file') return false;
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

async function consumeSSEStream(response: Response): Promise<any[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];
  const flushEventBlock = (block: string) => {
    let eventName: string | undefined;
    let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) return;
    let parsed: any;
    try { parsed = JSON.parse(dataLine); }
    catch { return; }
    if (eventName && (!parsed || typeof parsed !== 'object' || !('type' in parsed))) {
      parsed = { type: eventName, ...(typeof parsed === 'object' ? parsed : { value: parsed }) };
    }
    events.push(parsed);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) flushEventBlock(part);
  }
  if (buffer.trim()) flushEventBlock(buffer);
  return events;
}

async function executeAndGetRunId(
  benchmarkId: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  const response = await fetch(
    `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `execute failed: ${response.status} ${response.statusText} ${await response.text().catch(() => '')}`,
    );
  }
  const events = await consumeSSEStream(response);
  const started = events.find(e => e.type === 'started');
  return started?.runId ?? null;
}

describe('Benchmark execute (legacy path) — imageDigest stamping', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];
  const createdImageDigests: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        `[benchmarkExecuteImageDigest.integ] Backend not available at ${BASE_URL} — skipping all tests`,
      );
    }
  });

  afterAll(async () => {
    for (const benchmarkId of createdBenchmarkIds) {
      try {
        const bm = await (await fetch(
          `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
        )).json();
        for (const run of (bm.runs || []) as any[]) {
          for (const result of Object.values(run.results || {}) as any[]) {
            if (result?.reportId) {
              await fetch(
                `${BASE_URL}/api/storage/runs/${encodeURIComponent(result.reportId)}`,
                { method: 'DELETE' },
              ).catch(() => { /* ignore */ });
            }
          }
        }
      } catch { /* ignore — best-effort cleanup */ }
    }
    for (const id of createdBenchmarkIds) {
      await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(() => { /* ignore */ });
    }
    for (const id of createdTestCaseIds) {
      await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(() => { /* ignore */ });
    }
    for (const digest of createdImageDigests) {
      await fetch(
        `${BASE_URL}/api/storage/images/${encodeURIComponent(digest)}`,
        { method: 'DELETE' },
      ).catch(() => { /* ignore */ });
    }
  });

  async function seedBenchmark(suffix: string): Promise<{ benchmarkId: string; testCaseId: string }> {
    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ImageDigest legacy-path TC ${suffix}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Demo prompt for legacy-path digest test',
        context: [],
        expectedOutcomes: ['demo outcome'],
        expectedTrajectory: [],
      }),
    });
    if (!tcRes.ok) {
      throw new Error(`create test case failed: ${tcRes.status} ${await tcRes.text().catch(() => '')}`);
    }
    const tc = await tcRes.json();
    const testCaseId: string = tc.id || tc.testCase?.id;
    createdTestCaseIds.push(testCaseId);

    const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ImageDigest legacy-path BM ${suffix}`,
        description: 'Pinning legacy /execute imageDigest stamping',
        testCaseIds: [testCaseId],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: [testCaseId],
        }],
      }),
    });
    if (!bmRes.ok) {
      throw new Error(`create benchmark failed: ${bmRes.status} ${await bmRes.text().catch(() => '')}`);
    }
    const bm = await bmRes.json();
    const benchmarkId: string = bm.id || bm.benchmark?.id;
    createdBenchmarkIds.push(benchmarkId);
    return { benchmarkId, testCaseId };
  }

  it(
    'stamps a real sha256 imageDigest on the BenchmarkRun and find-or-creates the backing image doc',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark(`digest-${Date.now()}`);

      const runId = await executeAndGetRunId(benchmarkId, {
        name: 'Legacy digest run',
        agentKey: 'demo',
        modelId: 'demo-model',
        evaluatorId: 'system-rca-default',
      });
      expect(runId).toBeDefined();

      const bmRes = await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
      );
      expect(bmRes.status).toBe(200);
      const bm = await bmRes.json();
      const run = bm.runs?.find((r: any) => r.id === runId);

      expect(run).toBeDefined();
      expect(run.imageDigest).toMatch(SHA256_HEX);
      createdImageDigests.push(run.imageDigest);

      // The image doc this run's digest points to actually exists — not
      // just a field on the run with nothing backing it.
      const imageRes = await fetch(
        `${BASE_URL}/api/storage/images/${encodeURIComponent(run.imageDigest)}`,
      );
      expect(imageRes.status).toBe(200);
      const { image } = await imageRes.json();
      expect(image.digest).toBe(run.imageDigest);
      expect(image.testCaseCount).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'produces the SAME digest re-running against identical content (content-addressed identity, same as the unified path)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId, testCaseId } = await seedBenchmark(`repeat-${Date.now()}`);
      void testCaseId;

      const runConfig = {
        name: 'Legacy digest run (repeat)',
        agentKey: 'demo',
        modelId: 'demo-model',
        evaluatorId: 'system-rca-default',
      };

      const runId1 = await executeAndGetRunId(benchmarkId, runConfig);
      const runId2 = await executeAndGetRunId(benchmarkId, runConfig);
      expect(runId1).toBeDefined();
      expect(runId2).toBeDefined();
      expect(runId1).not.toBe(runId2);

      const bm = await (await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
      )).json();
      const run1 = bm.runs?.find((r: any) => r.id === runId1);
      const run2 = bm.runs?.find((r: any) => r.id === runId2);

      expect(run1.imageDigest).toMatch(SHA256_HEX);
      expect(run2.imageDigest).toBe(run1.imageDigest);
      createdImageDigests.push(run1.imageDigest);
    },
    TEST_TIMEOUT * 3, // two sequential full agent+judge runs, not one
  );
});
