/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: evaluation-run creation stamps an image digest and
 * find-or-creates the benchmark image (content-addressed dedup).
 *
 * The "same command → new benchmark every time" bug, inverted: running the
 * same evaluation twice must converge on ONE image (same digest), with both
 * runs stamped by it — and GET /api/storage/images/:digest returns both runs
 * as the comparable set.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it
 * creates.
 */

import { ApiClient } from '@/cli/utils/apiClient';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 180000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) return false;
    const storageHealth = await fetch(`${BASE_URL}/api/storage/health`);
    const storageData = await storageHealth.json();
    return storageData.status === 'ok';
  } catch {
    return false;
  }
};

describe('Benchmark image digest stamping (integration)', () => {
  let backendAvailable = false;
  let client: ApiClient;
  const createdTestCaseIds: string[] = [];
  const createdRunIds: string[] = [];
  const createdImageDigests: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      return;
    }
    client = new ApiClient(BASE_URL);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;
    await Promise.all([
      ...createdRunIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).catch(() => {})
      ),
      ...createdTestCaseIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).catch(() => {})
      ),
      ...createdImageDigests.map((digest) =>
        fetch(`${BASE_URL}/api/storage/images/${encodeURIComponent(digest)}`, {
          method: 'DELETE',
        }).catch(() => {})
      ),
    ]);
  }, TEST_TIMEOUT);

  it(
    'two identical runs share ONE image; changing the test-case set forks a second image',
    async () => {
      if (!backendAvailable) return;

      const bulk = await client.bulkCreateTestCases([
        {
          name: `image-dedup-tc-${Date.now()}`,
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say hello.',
          expectedOutcomes: ['Greets the user'],
        },
      ]);
      createdTestCaseIds.push(...bulk.testCases.map((tc) => tc.id));

      const createRun = async (i: number, sourceIds: string[] = createdTestCaseIds) => {
        const run = await client.createEvaluationRun(
          {
            name: `image-dedup-run-${Date.now()}-${i}`,
            sources: [{ type: 'test-case-ids', ids: sourceIds }],
            agentKey: 'demo',
            modelId: 'demo-model',
            trigger: 'cli',
          } as any,
          () => {}
        );
        if (run?.id) createdRunIds.push(run.id);
        return run;
      };

      // Same "command" twice
      const run1 = await createRun(1);
      const run2 = await createRun(2);
      expect(run1?.imageDigest).toBeTruthy();
      expect(run2?.imageDigest).toBe(run1?.imageDigest);
      const digest = run1!.imageDigest!;
      createdImageDigests.push(digest);

      // ONE image exists for that digest; it lists both runs (comparable set)
      const imageRes = await fetch(`${BASE_URL}/api/storage/images/${digest}`);
      expect(imageRes.status).toBe(200);
      const imageBody = await imageRes.json();
      expect(imageBody.image.digest).toBe(digest);
      expect(imageBody.image.testCaseCount).toBe(1);      const runIds = imageBody.runs.map((r: any) => r.id);
      expect(runIds).toEqual(expect.arrayContaining([run1!.id, run2!.id]));

      // Changing a control (the test-case set) forks a NEW image — correctly,
      // because the runs are no longer comparable. (Judge-model/evaluator
      // forking is covered at the unit level in benchmarkImage.test.ts.)
      const bulk2 = await client.bulkCreateTestCases([
        {
          name: `image-dedup-tc2-${Date.now()}`,
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say goodbye.',
          expectedOutcomes: ['Bids farewell'],
        },
      ]);
      createdTestCaseIds.push(...bulk2.testCases.map((tc) => tc.id));
      const run3 = await createRun(3, createdTestCaseIds);
      expect(run3?.imageDigest).toBeTruthy();
      expect(run3?.imageDigest).not.toBe(digest);
      if (run3?.imageDigest) createdImageDigests.push(run3.imageDigest);

      // Images never surface as benchmarks
      const benchmarks = await client.listBenchmarks();
      expect(benchmarks.find((b: any) => b.docType === 'benchmark-image')).toBeUndefined();
    },
    TEST_TIMEOUT
  );

  it(
    'tagging an image is idempotent and never changes identity',
    async () => {
      if (!backendAvailable) return;
      if (createdImageDigests.length === 0) return;
      const digest = createdImageDigests[0];

      const tagRes = await fetch(`${BASE_URL}/api/storage/images/${digest}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'integration:v1' }),
      });
      expect(tagRes.status).toBe(200);
      const tagged = (await tagRes.json()).image;
      expect(tagged.tags).toContain('integration:v1');
      expect(tagged.digest).toBe(digest); // tag is a label, not identity

      // Idempotent
      await fetch(`${BASE_URL}/api/storage/images/${digest}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'integration:v1' }),
      });
      const again = await (await fetch(`${BASE_URL}/api/storage/images/${digest}`)).json();
      expect(again.image.tags.filter((t: string) => t === 'integration:v1')).toHaveLength(1);
    },
    TEST_TIMEOUT
  );
});
