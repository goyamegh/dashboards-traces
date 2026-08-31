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
 * This is a read-modify-write over the WHOLE `versions[]` array (not a
 * single-field increment), and every `IBenchmarkOperations.update()`
 * implementation in this repo (OpenSearch and file) is itself a plain
 * read-then-full-reindex/write with no optimistic-concurrency guard —
 * `IBenchmarkOperations` doesn't expose `_seq_no`/`_primary_term` or an
 * equivalent CAS token to callers. This function now runs on EVERY
 * `POST /api/storage/evaluation-runs` (not just an explicit repair
 * command), so concurrent runs against the same benchmark — the realistic
 * case is a CLI campaign firing several runs back-to-back — can race: two
 * callers both read the same snapshot, each computes its own merge, and
 * whichever writes second overwrites the first writer's `versions[]` with
 * a snapshot that never saw the first writer's ids (lost update), or
 * clobbers a *version bump* that landed concurrently via the normal
 * `PUT /api/storage/benchmarks/:id` edit flow.
 *
 * Mitigated with a bounded (3-attempt) optimistic retry: each attempt
 * re-reads the benchmark fresh, computes the merge against THAT read, then
 * re-reads once more immediately before writing — if the two reads within
 * the same attempt disagree (structural fingerprint: `updatedAt` +
 * top-level count + `currentVersion` + each version's own id count),
 * someone else wrote in between, so the attempt is abandoned and retried
 * against the newer state instead of writing a stale merge over it. This
 * closes the race for the common case (a handful of near-simultaneous
 * requests) but is NOT true CAS: a write landing in the small window
 * between the final freshness check and this function's own `update()`
 * call is still possible and would still be silently overwritten. Closing
 * that completely would require `_seq_no`/`_primary_term` (or a painless
 * script, as `addRun`/`updateRun`/`deleteRun` already use for their
 * narrower single-field mutations) threaded through `IBenchmarkOperations`
 * — out of scope here; flagging as a residual, accepted risk rather than a
 * silent gap.
 */
export async function linkTestCaseIdsToBenchmark(
  benchmarkId: string,
  testCaseIds: string[],
  storage: IStorageModule,
): Promise<{ benchmark: Benchmark; added: string[] } | null> {
  const uniqueIncoming = Array.from(new Set(testCaseIds)).filter(Boolean);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const benchmark = await storage.benchmarks.getById(benchmarkId);
    if (!benchmark) return null;

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

    // Freshness re-check immediately before writing: re-read the benchmark
    // one more time and compare a cheap structural fingerprint against the
    // read we merged from above. If they differ, another writer touched
    // this benchmark in the gap — abandon this attempt's (now-stale) merge
    // and retry from the top against the newer state, rather than writing
    // over it.
    const recheck = await storage.benchmarks.getById(benchmarkId);
    if (!recheck || benchmarkFingerprint(recheck) !== benchmarkFingerprint(benchmark)) {
      continue;
    }

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

  // Every attempt saw the benchmark change out from under it before we could
  // write — bail out loudly instead of silently dropping ids or clobbering
  // whatever the other writer(s) landed. Callers (evaluation-run creation,
  // the repair-links route) already treat this function as fallible.
  throw new Error(
    `linkTestCaseIdsToBenchmark: benchmark ${benchmarkId} kept changing concurrently across ${MAX_ATTEMPTS} attempts — aborting instead of risking a lost update`
  );
}

/**
 * Cheap "did the benchmark move" signal for the optimistic-retry check
 * above — not a cryptographic hash, just enough of the mutable shape
 * (`updatedAt`, top-level id count, `currentVersion`, and each version's own
 * id count) that any write this function or the normal edit flow could make
 * changes it. Order-sensitive by design: a version's ids being reordered
 * would evade a length-only check, but every real writer here only ever
 * APPENDS ids (never reorders), so length is a sufficient proxy in practice.
 */
function benchmarkFingerprint(b: Benchmark): string {
  const versionsSig = (b.versions || []).map(v => `${v.version}:${(v.testCaseIds || []).length}`).join(',');
  return `${b.updatedAt}|${(b.testCaseIds || []).length}|${b.currentVersion ?? 1}|${versionsSig}`;
}
