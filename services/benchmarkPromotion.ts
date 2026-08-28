/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkVersion, EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

export async function promoteRunToBenchmark(
  runId: string,
  benchmarkName: string,
  storage: IStorageModule
): Promise<{ benchmark: Benchmark; run: EvaluationRun }> {
  // 1. Fetch the run
  const run = await storage.evaluationRuns.getById(runId);
  if (!run) {
    throw new Error('Evaluation run not found');
  }

  // 2. Check if already associated
  if (run.benchmarkId) {
    throw new Error('Run is already associated with a benchmark');
  }

  // 3. Get test case IDs from snapshots
  const testCaseIds = run.testCaseSnapshots.map(s => s.id);

  // 4. Try to find existing benchmark by name
  const { items: allBenchmarks } = await storage.benchmarks.getAll();
  const existingBenchmark = allBenchmarks.find(b => b.name === benchmarkName);

  let benchmark: Benchmark;

  if (existingBenchmark) {
    // 5. Update existing benchmark
    benchmark = await storage.benchmarks.update(existingBenchmark.id, { testCaseIds });
  } else {
    // 6. Create new benchmark
    benchmark = await storage.benchmarks.create({
      name: benchmarkName,
      testCaseIds,
      description: `Promoted from run ${run.name || run.id}`,
    });
  }

  // 7. Link the run to the benchmark
  const updatedRun = await storage.evaluationRuns.update(runId, { benchmarkId: benchmark.id });

  // 8. Return both
  return { benchmark, run: updatedRun };
}

/**
 * Link freshly-created/resolved test case ids into a benchmark, unioning
 * them into BOTH the top-level `testCaseIds` AND the current version's own
 * `testCaseIds` entry, in place — no version bump.
 *
 * `types/index.ts`'s `Benchmark.testCaseIds` is documented as a "convenience
 * accessor - mirrors latest version"; this function is what's responsible
 * for upholding that invariant when ids are linked outside the normal
 * `PUT /api/storage/benchmarks/:id` edit flow (which bumps a new version
 * whenever `testCaseIds` changes). Root cause it fixes: a shell benchmark
 * created with `testCaseIds: []` (e.g. `agent-health benchmark -f
 * foo.eval.js -n "My Benchmark"`) got its top level populated on first link,
 * but a *second* link call for the same ids saw the top level already
 * satisfied and returned early without ever checking whether the CURRENT
 * version's own `testCaseIds` array (the one the benchmark page's test-case
 * panel actually renders — see `lib/benchmarkVersionUtils.ts`
 * `getSelectedVersionData` → `getVersionTestCases`) had been populated too.
 * Benchmarks that had their top level set directly (bypassing this
 * function entirely) hit the same shape from the start: correct top-level
 * links, permanently empty current-version array, so the panel renders "No
 * test cases in this version" despite the benchmark clearly having test
 * cases.
 *
 * (An earlier revision of this function bumped to a brand-new version
 * instead of updating the current one in place — that's the shape a
 * concurrently-merged branch reintroduced; this revision supersedes it.)
 *
 * Used by (1) `POST /api/storage/evaluation-runs` at run-creation time —
 * every source resolves to concrete test case ids before execution, so
 * they're linked immediately, independent of whether the run itself
 * succeeds — and (2) `agent-health benchmark repair-links --apply`'s
 * backfill for benchmarks that went stale before this fix existed (see
 * `cli/utils/benchmarkDoctor.ts`), via `POST
 * /api/storage/benchmarks/:id/link-test-case-ids`.
 *
 * No-op (returns `added: []`, no write) when both the top-level array and
 * the current version's array already contain every id.
 */
export async function linkTestCaseIdsToBenchmark(
  benchmarkId: string,
  testCaseIds: string[],
  storage: IStorageModule,
): Promise<{ benchmark: Benchmark; added: string[] } | null> {
  const benchmark = await storage.benchmarks.getById(benchmarkId);
  if (!benchmark) return null;

  const uniqueIncoming = Array.from(new Set(testCaseIds)).filter(Boolean);

  const existingTopLevelIds = benchmark.testCaseIds || [];
  const topLevelSet = new Set(existingTopLevelIds);
  const added = uniqueIncoming.filter(id => !topLevelSet.has(id));
  const mergedTopLevelIds = added.length > 0 ? [...existingTopLevelIds, ...added] : existingTopLevelIds;

  // Current version entry — synthesize v1 from the top level for legacy docs
  // that predate versioning entirely (mirrors normalizeBenchmark's fallback
  // in server/routes/storage/benchmarks.ts).
  const currentVersion = benchmark.currentVersion ?? 1;
  const versions: BenchmarkVersion[] = benchmark.versions && benchmark.versions.length > 0
    ? benchmark.versions
    : [{ version: 1, createdAt: benchmark.createdAt, testCaseIds: existingTopLevelIds }];
  let currentVersionIndex = versions.findIndex(v => v.version === currentVersion);
  if (currentVersionIndex === -1) currentVersionIndex = versions.length - 1;
  const currentVersionEntry = versions[currentVersionIndex];
  const existingVersionIds = currentVersionEntry.testCaseIds || [];
  const versionSet = new Set(existingVersionIds);
  const missingFromVersion = uniqueIncoming.filter(id => !versionSet.has(id));

  const topLevelChanged = added.length > 0;
  const versionChanged = missingFromVersion.length > 0;

  if (!topLevelChanged && !versionChanged) {
    return { benchmark, added: [] };
  }

  const mergedVersionIds = versionChanged
    ? [...existingVersionIds, ...missingFromVersion]
    : existingVersionIds;

  const updatedVersions = versions.slice();
  updatedVersions[currentVersionIndex] = {
    ...currentVersionEntry,
    testCaseIds: mergedVersionIds,
  };

  const updated = await storage.benchmarks.update(benchmarkId, {
    testCaseIds: mergedTopLevelIds,
    // currentVersion / other fields intentionally omitted — this links ids
    // into the benchmark's EXISTING current version in place rather than
    // bumping a new one. Storage adapters shallow-merge partial updates
    // ({ ...existing, ...updates }), so omitted fields are left untouched.
    versions: updatedVersions,
  });

  return { benchmark: updated, added };
}
