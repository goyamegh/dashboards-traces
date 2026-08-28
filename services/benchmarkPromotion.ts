/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, EvaluationRun } from '@/types';
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
 * Link freshly-created/resolved test case ids into a benchmark's
 * `testCaseIds` (bumping the version, same as `PUT /api/storage/benchmarks/:id`
 * does when test cases change) so a run-first `EvaluationRun` created against
 * `benchmarkId` doesn't leave the benchmark a testCaseIds-less shell.
 *
 * Used by (1) `POST /api/storage/evaluation-runs` at run-creation time —
 * every source resolves to concrete test case ids before execution, so
 * they're linked immediately, independent of whether the run itself
 * succeeds — and (2) `agent-health benchmark doctor --apply`'s repair for
 * benchmarks that already went stale before this fix existed.
 *
 * No-op (returns `added: []`, no version bump, no write) when every id is
 * already present.
 */
export async function linkTestCaseIdsToBenchmark(
  benchmarkId: string,
  testCaseIds: string[],
  storage: IStorageModule,
): Promise<{ benchmark: Benchmark; added: string[] } | null> {
  const benchmark = await storage.benchmarks.getById(benchmarkId);
  if (!benchmark) return null;

  const existingIds = benchmark.testCaseIds || [];
  const existingSet = new Set(existingIds);
  const added = Array.from(new Set(testCaseIds)).filter(id => id && !existingSet.has(id));
  if (added.length === 0) {
    return { benchmark, added: [] };
  }

  const mergedIds = [...existingIds, ...added];
  const currentVersion = benchmark.currentVersion ?? 1;
  const versions = benchmark.versions && benchmark.versions.length > 0
    ? benchmark.versions
    : [{ version: 1, createdAt: benchmark.createdAt, testCaseIds: existingIds }];
  const newVersion = currentVersion + 1;
  const newVersionEntry = {
    version: newVersion,
    createdAt: new Date().toISOString(),
    testCaseIds: mergedIds,
  };

  const updated = await storage.benchmarks.update(benchmarkId, {
    testCaseIds: mergedIds,
    currentVersion: newVersion,
    versions: [...versions, newVersionEntry],
  });

  return { benchmark: updated, added };
}
