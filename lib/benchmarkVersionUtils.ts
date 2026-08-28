/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkVersion, BenchmarkRun, TestCase } from '@/types';

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
