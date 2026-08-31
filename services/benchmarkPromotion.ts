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
 * Link freshly-created/resolved test case ids into a benchmark, unioning
 * them into BOTH the top-level `testCaseIds` AND the current version's own
 * `testCaseIds` entry, in place — no version bump.
 *
 * `types/index.ts`'s `Benchmark.testCaseIds` is documented as a "convenience
 * accessor - mirrors latest version"; this is the invariant `IBenchmarkOperations
 * .linkTestCaseIds()` (see server/adapters/types.ts) upholds when ids are
 * linked outside the normal `PUT /api/storage/benchmarks/:id` edit flow
 * (which bumps a new version whenever `testCaseIds` changes). Root cause it
 * fixes: a shell benchmark created with `testCaseIds: []` (e.g. `agent-health
 * benchmark -f foo.eval.js -n "My Benchmark"`) got its top level populated on
 * first link, but a *second* link call for the same ids saw the top level
 * already satisfied and returned early without ever checking whether the
 * CURRENT version's own `testCaseIds` array (the one the benchmark page's
 * test-case panel actually renders — see `lib/benchmarkVersionUtils.ts`
 * `getSelectedVersionData` → `getVersionTestCases`) had been populated too.
 * Benchmarks that had their top level set directly (bypassing this
 * function entirely) hit the same shape from the start: correct top-level
 * links, permanently empty current-version array, so the panel renders "No
 * test cases in this version" despite the benchmark clearly having test
 * cases.
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
 *
 * ## Concurrency
 *
 * This function now runs on EVERY `POST /api/storage/evaluation-runs` (not
 * just an explicit repair command), so concurrent runs against the same
 * benchmark — the realistic case is a CLI campaign firing several runs
 * back-to-back — are expected. A first version of this function did the
 * read-modify-write itself, client-side, with a fingerprint-based
 * optimistic retry; codex_review correctly flagged that this still raced
 * on the WRITE — two callers could both pass the fingerprint recheck
 * against the same snapshot and then both call the plain `update()`
 * (itself a read-then-full-document-overwrite in every
 * `IBenchmarkOperations` implementation), and whichever wrote second would
 * still clobber the first. The actual atomic mutation now lives entirely
 * in `storage.benchmarks.linkTestCaseIds()` — a Painless scripted
 * `_update` for the OpenSearch adapter, a process-serialized
 * read-modify-write for the file adapter (see both adapters' own
 * docstrings in `server/adapters/{opensearch,file}/StorageModule.ts`) —
 * which is genuinely safe to call concurrently. This function is now a
 * thin, storage-agnostic delegator.
 */
export async function linkTestCaseIdsToBenchmark(
  benchmarkId: string,
  testCaseIds: string[],
  storage: IStorageModule,
): Promise<{ benchmark: Benchmark; added: string[] } | null> {
  return storage.benchmarks.linkTestCaseIds(benchmarkId, testCaseIds);
}
