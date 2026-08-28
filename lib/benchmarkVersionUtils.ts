/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkVersion, BenchmarkRun, EvaluationRun, TestCase } from '@/types';

/**
 * Enhanced version data with diff information
 */
export interface VersionData {
  version: number;
  createdAt: string;
  testCaseIds: string[];
  isLatest: boolean;
  added: string[];
  removed: string[];
  runCount: number;
}

/**
 * Compute version data with diff information for a benchmark.
 * Returns versions sorted by version number (newest first) with added/removed test case IDs.
 */
export function computeVersionData(benchmark: Benchmark | null): VersionData[] {
  if (!benchmark?.versions || benchmark.versions.length === 0) return [];

  return benchmark.versions
    .slice() // Create a copy to avoid mutating original
    .sort((a, b) => b.version - a.version) // Newest first
    .map((v, index, arr) => {
      const prevVersion = arr[index + 1]; // Previous version (older)
      const added = prevVersion
        ? v.testCaseIds.filter(id => !prevVersion.testCaseIds.includes(id))
        : [];
      const removed = prevVersion
        ? prevVersion.testCaseIds.filter(id => !v.testCaseIds.includes(id))
        : [];
      const runCount = benchmark.runs?.filter(r =>
        (r.benchmarkVersion || 1) === v.version
      ).length || 0;

      return {
        ...v,
        isLatest: index === 0,
        added,
        removed,
        runCount,
      };
    });
}

/**
 * Get version data for a specific version number or the latest version.
 * @param versionData - Array of computed version data
 * @param selectedVersion - Version number to get, or null for latest
 */
export function getSelectedVersionData(
  versionData: VersionData[],
  selectedVersion: number | null
): VersionData | null {
  if (versionData.length === 0) return null;
  if (selectedVersion === null) return versionData[0]; // Latest
  return versionData.find(v => v.version === selectedVersion) || versionData[0];
}

/**
 * Get test cases for a specific version.
 * @param testCases - All available test cases
 * @param selectedVersionData - The version data to get test cases for
 */
export function getVersionTestCases(
  testCases: TestCase[],
  selectedVersionData: VersionData | null
): TestCase[] {
  if (!selectedVersionData) return [];
  return testCases.filter(tc =>
    selectedVersionData.testCaseIds.includes(tc.id)
  );
}

/**
 * Filter runs by version.
 * @param runs - All benchmark runs
 * @param versionFilter - Version number to filter by, or 'all' for all runs
 */
export function filterRunsByVersion(
  runs: BenchmarkRun[] | undefined,
  versionFilter: number | 'all'
): BenchmarkRun[] {
  if (!runs) return [];
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  if (versionFilter === 'all') return sorted;
  return sorted.filter(run =>
    (run.benchmarkVersion || 1) === versionFilter
  );
}

/**
 * Resolve the effective run-version filter from a persisted (possibly stale)
 * value. A persisted version the benchmark doesn't actually have — e.g. a
 * filter set while viewing a different benchmark under the old global
 * localStorage key, a deleted version, or corrupted storage — must behave as
 * 'all' rather than filtering every run out and rendering a bogus
 * "No runs for vN" empty state that looks like data loss.
 *
 * @param raw - persisted filter value
 * @param availableVersions - the benchmark's actual version numbers
 *   (undefined while the benchmark is still loading — value passes through)
 */
export function effectiveRunVersionFilter(
  raw: number | 'all',
  availableVersions: number[] | undefined
): number | 'all' {
  if (raw === 'all') return 'all';
  if (!Number.isInteger(raw) || raw < 1) return 'all';
  if (availableVersions !== undefined && !availableVersions.includes(raw)) return 'all';
  return raw;
}

/**
 * A benchmark run tagged with which storage model it came from.
 *
 * There are two disjoint run record shapes today: legacy benchmark-embedded
 * runs (`benchmark.runs[]`) and top-level evaluation-runs (`eval-run-…`,
 * created by the unified `/api/storage/evaluation-runs` path — code-import,
 * `benchmark -f`, run-prioritizer). `__kind` records which model a row came
 * from so callers (e.g. the run-inspector link) can target the right route.
 * Mirrors the merge already done in `EvalRunsPage.tsx`'s `RunRow`.
 */
export type RunWithKind = BenchmarkRun & { __kind: 'benchmark' | 'eval-run' };

/**
 * Union embedded `benchmark.runs[]` with run-first `EvaluationRun` documents
 * that reference this benchmark (`evaluationRun.benchmarkId`), de-duplicated
 * by id (embedded wins on a collision, though the two id spaces never
 * actually collide — `run-…` vs `eval-run-…`).
 *
 * Without this, a benchmark run started via `agent-health benchmark -f
 * foo.eval.js -n "My Benchmark"` (which creates a run-first EvaluationRun,
 * not an embedded run) never appears on `/evaluations/benchmarks/:id/runs`
 * even though `GET /api/storage/evaluation-runs?benchmarkId=...` returns it
 * correctly — the benchmark-runs page only ever read `benchmark.runs[]`.
 *
 * `EvaluationRun` is shape-compatible with `BenchmarkRun` for every field
 * the runs list/inspector reads (id, name, agentKey, modelId, createdAt,
 * results, stats, benchmarkVersion, testCaseSnapshots) — same cast used by
 * `EvalRunsPage.tsx`.
 */
export function mergeEvalRunsIntoBenchmarkRuns(
  embeddedRuns: BenchmarkRun[] | undefined,
  evalRuns: EvaluationRun[] | undefined,
): RunWithKind[] {
  const merged: RunWithKind[] = (embeddedRuns || []).map(r => ({ ...r, __kind: 'benchmark' as const }));
  const seen = new Set(merged.map(r => r.id));
  for (const er of evalRuns || []) {
    if (seen.has(er.id)) continue;
    seen.add(er.id);
    merged.push({ ...(er as unknown as BenchmarkRun), __kind: 'eval-run' as const });
  }
  return merged;
}

/**
 * Path to the run inspector for a run that may be embedded or run-first.
 * Run-first (`__kind === 'eval-run'`) rows must route to the SDK eval-run
 * mode (`/evaluations/runs/:runId/inspect`, no `benchmarkId` param) — the
 * benchmark-scoped route looks the run up via `bm.runs.find(...)`, which
 * never contains run-first runs.
 */
export function runInspectPath(benchmarkId: string, run: { id: string; __kind?: 'benchmark' | 'eval-run' }): string {
  return run.__kind === 'eval-run'
    ? `/evaluations/runs/${run.id}/inspect`
    : `/evaluations/benchmarks/${benchmarkId}/runs/${run.id}/inspect`;
}
