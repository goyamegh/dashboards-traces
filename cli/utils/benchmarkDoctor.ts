/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure planner for `agent-health benchmark doctor` — detects benchmarks
 * whose linked run-first `EvaluationRun` documents reference test case ids
 * missing from `benchmark.testCaseIds` and computes the repair (ids to add).
 *
 * Root cause: `POST /api/storage/evaluation-runs` used to persist a run with
 * `benchmarkId` set without ever touching the referenced benchmark's
 * `testCaseIds` (fixed going forward by
 * `services/benchmarkPromotion.ts:linkTestCaseIdsToBenchmark`, called at run
 * creation time). This module is the *backfill* for benchmarks that went
 * stale before that fix existed — no network/storage calls, so it's cheap
 * to unit test and safe to run as a dry-run by default.
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
