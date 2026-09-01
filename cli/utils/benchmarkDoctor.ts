/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure planners for `agent-health benchmark repair-links` — detect two
 * shapes of the same underlying bug class (a benchmark's `testCaseIds` and
 * its version history drifting out of sync) and compute the repair. No
 * network/storage calls, so these are cheap to unit test and safe to run as
 * a dry-run by default.
 *
 * - `computeBenchmarkRepairPlan` / `applyRepairPlan` — "stale shell": a
 *   linked run-first `EvaluationRun` document references test case ids
 *   missing from `benchmark.testCaseIds` (top level). Root cause: before
 *   `services/benchmarkPromotion.ts:linkTestCaseIdsToBenchmark` existed,
 *   `POST /api/storage/evaluation-runs` never wrote resolved ids back into
 *   the referenced benchmark at all.
 *
 * - `computeVersionLinkRepairPlan` — "stale version": `benchmark.testCaseIds`
 *   (top level) already has ids that the CURRENT version's own `testCaseIds`
 *   entry is missing. This is the shape that made the benchmark page's
 *   test-case panel render "No test cases in this version" despite correct
 *   top-level links — the panel reads `versions[currentVersion].testCaseIds`
 *   (`lib/benchmarkVersionUtils.ts` `getSelectedVersionData` →
 *   `getVersionTestCases`), never the top level. It can happen independent
 *   of any run reference (e.g. a benchmark whose top level was set directly,
 *   bypassing `linkTestCaseIdsToBenchmark`), so unlike the stale-shell check
 *   it does not require any linked runs to detect.
 *
 * Multi-version caveat (codex_review finding, see PR discussion): neither
 * planner is version-aware — `computeBenchmarkRepairPlan` unions every
 * linked run's snapshot ids into the TOP LEVEL regardless of which version
 * was current when that run happened, and `computeVersionLinkRepairPlan`
 * then offers to copy the (possibly cross-version) top level into the
 * CURRENT version. For a benchmark that has only ever been linked via
 * `linkTestCaseIdsToBenchmark` (which never bumps a version) this is safe —
 * there is only one version, so there is nothing to cross-contaminate. Once
 * a benchmark has been manually edited at least once (a real version bump),
 * blending in top-level ids that may have arrived via an older version's
 * runs would silently mix an older version's test cases into the current
 * one. `computeVersionLinkRepairPlan` flags this via `needsManualReview`
 * instead of guessing, and the CLI command skips `--apply` for flagged
 * plans (still reports them in dry-run so a human can look).
 */

import type { Benchmark, EvaluationRun } from '@/types/index.js';

export interface BenchmarkRepairPlan {
  benchmarkId: string;
  benchmarkName: string;
  /** Test case ids referenced by a linked run but missing from testCaseIds. */
  missingTestCaseIds: string[];
  /** Ids of the evaluation runs that referenced at least one missing id. */
  affectedRunIds: string[];
}

/**
 * Compute the repair plan for a single benchmark, given the run-first
 * evaluation runs that reference it (caller filters by `benchmarkId`, or
 * passes an already-filtered list — either way runs whose `benchmarkId`
 * doesn't match `benchmark.id` are ignored defensively).
 *
 * Returns `null` when there is nothing to repair (no runs reference missing
 * ids) so callers can treat `null` as "healthy, skip".
 */
export function computeBenchmarkRepairPlan(
  benchmark: Pick<Benchmark, 'id' | 'name' | 'testCaseIds'>,
  evaluationRuns: Array<Pick<EvaluationRun, 'id' | 'benchmarkId' | 'testCaseSnapshots'>>,
): BenchmarkRepairPlan | null {
  const existing = new Set(benchmark.testCaseIds || []);
  const missing = new Set<string>();
  const affectedRunIds: string[] = [];

  for (const run of evaluationRuns) {
    if (run.benchmarkId !== benchmark.id) continue;
    let runHasMissing = false;
    for (const snapshot of run.testCaseSnapshots || []) {
      if (snapshot?.id && !existing.has(snapshot.id)) {
        missing.add(snapshot.id);
        runHasMissing = true;
      }
    }
    if (runHasMissing) affectedRunIds.push(run.id);
  }

  if (missing.size === 0) return null;

  return {
    benchmarkId: benchmark.id,
    benchmarkName: benchmark.name,
    missingTestCaseIds: Array.from(missing),
    affectedRunIds,
  };
}

/**
 * Apply a repair plan to a benchmark's testCaseIds (pure — returns the new
 * array, doesn't persist). Union semantics: existing ids are kept, missing
 * ids are appended once each, no duplicates either way.
 */
export function applyRepairPlan(existingTestCaseIds: string[], plan: BenchmarkRepairPlan): string[] {
  const existing = new Set(existingTestCaseIds || []);
  const result = [...existingTestCaseIds];
  for (const id of plan.missingTestCaseIds) {
    if (!existing.has(id)) {
      existing.add(id);
      result.push(id);
    }
  }
  return result;
}

export interface VersionLinkRepairPlan {
  benchmarkId: string;
  benchmarkName: string;
  /** The version number whose testCaseIds entry is missing ids. */
  currentVersion: number;
  /** Ids present in top-level testCaseIds but missing from the current version's entry. */
  missingTestCaseIds: string[];
  /**
   * True when this benchmark has more than one version. Backfilling the
   * CURRENT version's testCaseIds from the TOP LEVEL is only known-safe when
   * the top level's contents are guaranteed to belong to the current
   * version — true for a benchmark that has only ever been linked via
   * `linkTestCaseIdsToBenchmark` (which never bumps a version), false once a
   * real version bump has happened, because the top level can by then
   * contain ids `computeBenchmarkRepairPlan` unioned in from a run against
   * an OLDER version (that planner has no version awareness). `--apply`
   * skips plans with this flag set; dry-run still reports them so a human
   * can decide what the CURRENT version's testCaseIds should actually be.
   */
  needsManualReview: boolean;
}

/**
 * Compute the version-level backfill plan for a single benchmark: detects
 * ids present in the top-level `testCaseIds` that are missing from the
 * CURRENT version's own `testCaseIds` entry (matched by `currentVersion`,
 * falling back to the last entry for a malformed/legacy doc whose
 * `currentVersion` doesn't match any entry).
 *
 * Returns `null` when there's nothing to repair: no top-level ids, no
 * versions to check against, or the current version already has every
 * top-level id.
 */
export function computeVersionLinkRepairPlan(
  benchmark: Pick<Benchmark, 'id' | 'name' | 'testCaseIds' | 'currentVersion' | 'versions'>,
): VersionLinkRepairPlan | null {
  const topLevelIds = benchmark.testCaseIds || [];
  if (topLevelIds.length === 0) return null;

  const versions = benchmark.versions || [];
  if (versions.length === 0) return null;

  const currentVersion = benchmark.currentVersion ?? 1;
  const currentEntry = versions.find(v => v.version === currentVersion) || versions[versions.length - 1];
  const existing = new Set(currentEntry?.testCaseIds || []);
  const missing = topLevelIds.filter(id => !existing.has(id));

  if (missing.length === 0) return null;

  return {
    benchmarkId: benchmark.id,
    benchmarkName: benchmark.name,
    currentVersion: currentEntry?.version ?? currentVersion,
    missingTestCaseIds: missing,
    needsManualReview: versions.length > 1,
  };
}
