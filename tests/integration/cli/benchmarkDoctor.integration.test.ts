/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: `benchmark doctor` apply path + image migration.
 *
 * Seeds a content-duplicate benchmark pair (same testCaseIds, different
 * names) with an eval-run pointing at the husk, then:
 *   - buildDoctorPlan detects exactly that group (scoped assertion — the
 *     shared backend may contain other groups);
 *   - applyDoctorPlan merges into the canonical, re-points the run, deletes
 *     the husk, and NEVER touches runs/reports;
 *   - migrateBenchmarksToImages converts the canonical into a tagged image.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it
 * creates.
 */

import { ApiClient } from '@/cli/utils/apiClient';
import { buildDoctorPlan } from '@/services/benchmarkDoctor';
import { applyDoctorPlan, migrateBenchmarksToImages } from '@/services/benchmarkDoctor';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 120000;
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

describe('benchmark doctor (integration)', () => {
  let backendAvailable = false;
  let client: ApiClient;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];
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
        fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})),
      ...createdBenchmarkIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})),
      ...createdTestCaseIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})),
      ...createdImageDigests.map((digest) =>
        fetch(`${BASE_URL}/api/storage/images/${encodeURIComponent(digest)}`, { method: 'DELETE' }).catch(() => {})),
    ]);
  }, TEST_TIMEOUT);

  it(
    'merges content duplicates, re-points runs, deletes husks — then migrates to a tagged image',
    async () => {
      if (!backendAvailable) return;

      const stamp = Date.now();

      // Seed: one test case, two benchmarks with identical content, one eval-run on the husk
      const bulk = await client.bulkCreateTestCases([
        {
          name: `doctor-tc-${stamp}`,
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say hello.',
          expectedOutcomes: ['Greets the user'],
        },
      ]);
      createdTestCaseIds.push(...bulk.testCases.map((tc) => tc.id));

      const canonical = await client.createBenchmark({
        name: `doctor-canonical-${stamp}`,
        description: 'doctor integration canonical',
        testCaseIds: createdTestCaseIds,
      });
      createdBenchmarkIds.push(canonical.id);
      const husk = await client.createBenchmark({
        name: `doctor-husk-${stamp}`,
        description: 'doctor integration husk (same content)',
        testCaseIds: createdTestCaseIds,
      });
      createdBenchmarkIds.push(husk.id);

      // Eval-run pointing at the husk (created via upsert PUT)
      const runId = `eval-run-doctor-${stamp}`;
      const putRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `doctor-run-${stamp}`,
          agentKey: 'demo',
          modelId: 'demo-model',
          sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
          trigger: 'cli',
          status: 'completed',
          testCaseSnapshots: [],
          results: {},
          createdAt: new Date().toISOString(),
          benchmarkId: husk.id,
        }),
      });
      expect(putRes.ok).toBe(true);
      createdRunIds.push(runId);

      // Plan — scope to our seeded group
      const [benchmarks, evalRuns] = await Promise.all([
        client.listBenchmarks(),
        client.listEvaluationRuns({ size: 1000 }),
      ]);
      const plan = buildDoctorPlan(benchmarks, evalRuns);
      // The husk holds the eval-run ref, so IT wins the canonical election —
      // match the group by id-set intersection, direction-agnostic.
      const ourIds = new Set([canonical.id, husk.id]);
      const ourGroup = plan.contentDupGroups.find(
        (g) => ourIds.has(g.canonicalId) || g.husks.some((h) => ourIds.has(h.id))
      );
      expect(ourGroup).toBeDefined();
      // Assert the group contains exactly our two docs, whichever direction.
      const groupIds = [ourGroup!.canonicalId, ...ourGroup!.husks.map((h) => h.id)].sort();
      expect(groupIds).toEqual([canonical.id, husk.id].sort());

      // Apply ONLY our group (never touch other people's data on a shared backend)
      const scopedPlan = { ...plan, contentDupGroups: [ourGroup!], debrisDeletions: [] };
      const result = await applyDoctorPlan(client, scopedPlan);
      expect(result.errors).toEqual([]);
      expect(result.husksDeleted).toBe(1);

      // The surviving doc exists; the other is gone; the run points at the survivor
      const survivor = await client.getBenchmark(ourGroup!.canonicalId);
      expect(survivor).not.toBeNull();
      for (const h of ourGroup!.husks) {
        expect(await client.getBenchmark(h.id)).toBeNull();
      }
      const runsAfter = await client.listEvaluationRuns({ benchmarkId: ourGroup!.canonicalId });
      expect(runsAfter.map((r) => r.id)).toContain(runId);

      // Migrate the survivor to a tagged image (scoped to OUR benchmark only
      // — never mass-migrate a shared backend from a test)
      const migration = await migrateBenchmarksToImages(client, BASE_URL, {
        benchmarkIds: [ourGroup!.canonicalId],
        dryRun: false,
      });
      const ours = migration.migrated.find((m) => m.benchmarkId === ourGroup!.canonicalId);
      expect(ours).toBeDefined();
      createdImageDigests.push(ours!.digest);
      const image = await client.getImage(ours!.digest);
      expect(image).not.toBeNull();
      expect(image!.image.tags).toContain(survivor!.name);
    },
    TEST_TIMEOUT
  );

  it(
    '--migrate-images dry-run preview computes the real digest but persists nothing; --apply then actually creates it',
    async () => {
      if (!backendAvailable) return;

      const stamp = Date.now();
      const bulk = await client.bulkCreateTestCases([
        {
          name: `doctor-dryrun-tc-${stamp}`,
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say hi.',
          expectedOutcomes: ['Greets the user'],
        },
      ]);
      createdTestCaseIds.push(...bulk.testCases.map((tc) => tc.id));

      const benchmark = await client.createBenchmark({
        name: `doctor-dryrun-bench-${stamp}`,
        description: 'doctor integration dry-run preview',
        testCaseIds: createdTestCaseIds,
      });
      createdBenchmarkIds.push(benchmark.id);

      // Default (dry-run): reports the real digest but creates nothing.
      const preview = await migrateBenchmarksToImages(client, BASE_URL, {
        benchmarkIds: [benchmark.id],
      });
      const previewed = preview.migrated.find((m) => m.benchmarkId === benchmark.id);
      expect(preview.dryRun).toBe(true);
      expect(previewed).toBeDefined();
      expect(previewed!.alreadyExists).toBe(false);
      expect(await client.getImage(previewed!.digest)).toBeNull();

      // --apply (dryRun: false): the SAME digest now actually gets created.
      const applied = await migrateBenchmarksToImages(client, BASE_URL, {
        benchmarkIds: [benchmark.id],
        dryRun: false,
      });
      const appliedEntry = applied.migrated.find((m) => m.benchmarkId === benchmark.id);
      expect(applied.dryRun).toBe(false);
      expect(appliedEntry).toBeDefined();
      expect(appliedEntry!.digest).toBe(previewed!.digest);
      createdImageDigests.push(appliedEntry!.digest);
      const image = await client.getImage(appliedEntry!.digest);
      expect(image).not.toBeNull();

      // Re-previewing the now-existing image reports alreadyExists: true.
      const secondPreview = await migrateBenchmarksToImages(client, BASE_URL, {
        benchmarkIds: [benchmark.id],
      });
      const secondPreviewed = secondPreview.migrated.find((m) => m.benchmarkId === benchmark.id);
      expect(secondPreviewed!.alreadyExists).toBe(true);
    },
    TEST_TIMEOUT
  );
});
