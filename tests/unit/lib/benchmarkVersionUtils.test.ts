/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeVersionData,
  getSelectedVersionData,
  getVersionTestCases,
  filterRunsByVersion,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import type { Benchmark, BenchmarkRun, TestCase } from '@/types';

describe('benchmarkVersionUtils', () => {
  // Helper to create a mock benchmark
  const createMockBenchmark = (overrides: Partial<Benchmark> = {}): Benchmark => ({
    id: 'bench-1',
    name: 'Test Benchmark',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: [],
    runs: [],
    ...overrides,
  });

  // Helper to create a mock test case
  const createMockTestCase = (id: string, name: string): TestCase => ({
    id,
    name,
    description: `Description for ${name}`,
    labels: ['test'],
    category: 'RCA',
    difficulty: 'Easy',
    currentVersion: 1,
    versions: [],
    isPromoted: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    initialPrompt: 'Test prompt',
    context: [],
  });

  // Helper to create a mock run
  const createMockRun = (
    id: string,
    benchmarkVersion: number,
    createdAt: string
  ): BenchmarkRun => ({
    id,
    name: `Run ${id}`,
    createdAt,
    agentKey: 'test-agent',
    modelId: 'test-model',
    benchmarkVersion,
    results: {},
  });

  describe('computeVersionData', () => {
    it('should return empty array for null benchmark', () => {
      const result = computeVersionData(null);
      expect(result).toEqual([]);
    });

    it('should return empty array for benchmark with no versions', () => {
      const benchmark = createMockBenchmark({ versions: [] });
      const result = computeVersionData(benchmark);
      expect(result).toEqual([]);
    });

    it('should return single version with isLatest=true and empty diffs', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
        ],
        runs: [],
      });

      const result = computeVersionData(benchmark);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-1', 'tc-2'],
        isLatest: true,
        added: [],
        removed: [],
        runCount: 0,
      });
    });

    it('should sort versions by version number descending (newest first)', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
          { version: 3, createdAt: '2026-01-03T00:00:00Z', testCaseIds: ['tc-1', 'tc-2', 'tc-3'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
        ],
      });

      const result = computeVersionData(benchmark);

      expect(result[0].version).toBe(3);
      expect(result[1].version).toBe(2);
      expect(result[2].version).toBe(1);
    });

    it('should mark only the highest version as isLatest', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
        ],
      });

      const result = computeVersionData(benchmark);

      expect(result[0].isLatest).toBe(true); // v2
      expect(result[1].isLatest).toBe(false); // v1
    });

    it('should compute added test cases correctly', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-2', 'tc-3'] },
        ],
      });

      const result = computeVersionData(benchmark);

      // v2 added tc-2 and tc-3 compared to v1
      expect(result[0].added).toEqual(['tc-2', 'tc-3']);
      // v1 is the first version, no previous version to compare
      expect(result[1].added).toEqual([]);
    });

    it('should compute removed test cases correctly', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2', 'tc-3'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1'] },
        ],
      });

      const result = computeVersionData(benchmark);

      // v2 removed tc-2 and tc-3 compared to v1
      expect(result[0].removed).toEqual(['tc-2', 'tc-3']);
      // v1 is the first version, no previous version to compare
      expect(result[1].removed).toEqual([]);
    });

    it('should compute both added and removed test cases', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-3'] },
        ],
      });

      const result = computeVersionData(benchmark);

      // v2: added tc-3, removed tc-2
      expect(result[0].added).toEqual(['tc-3']);
      expect(result[0].removed).toEqual(['tc-2']);
    });

    it('should count runs correctly for each version', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] },
        ],
        runs: [
          createMockRun('run-1', 1, '2026-01-01T01:00:00Z'),
          createMockRun('run-2', 1, '2026-01-01T02:00:00Z'),
          createMockRun('run-3', 1, '2026-01-01T03:00:00Z'),
          createMockRun('run-4', 2, '2026-01-02T01:00:00Z'),
        ],
      });

      const result = computeVersionData(benchmark);

      expect(result[0].runCount).toBe(1); // v2 has 1 run
      expect(result[1].runCount).toBe(3); // v1 has 3 runs
    });

    it('should default to version 1 for runs without benchmarkVersion', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
        ],
        runs: [
          {
            id: 'run-1',
            name: 'Legacy Run',
            createdAt: '2026-01-01T01:00:00Z',
            agentKey: 'test-agent',
            modelId: 'test-model',
            // No benchmarkVersion - legacy data
            results: {},
          } as BenchmarkRun,
        ],
      });

      const result = computeVersionData(benchmark);

      expect(result[0].runCount).toBe(1); // Legacy run counted as v1
    });

    it('should not mutate the original versions array', () => {
      const benchmark = createMockBenchmark({
        versions: [
          { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: ['tc-1'] },
          { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
        ],
      });

      const originalVersions = [...benchmark.versions];
      computeVersionData(benchmark);

      // Original should remain unsorted
      expect(benchmark.versions[0].version).toBe(originalVersions[0].version);
      expect(benchmark.versions[1].version).toBe(originalVersions[1].version);
    });
  });

  describe('getSelectedVersionData', () => {
    const versionData: VersionData[] = [
      {
        version: 2,
        createdAt: '2026-01-02T00:00:00Z',
        testCaseIds: ['tc-1', 'tc-2'],
        isLatest: true,
        added: ['tc-2'],
        removed: [],
        runCount: 2,
      },
      {
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-1'],
        isLatest: false,
        added: [],
        removed: [],
        runCount: 3,
      },
    ];

    it('should return null for empty version data', () => {
      const result = getSelectedVersionData([], null);
      expect(result).toBeNull();
    });

    it('should return null for empty version data with specific version', () => {
      const result = getSelectedVersionData([], 1);
      expect(result).toBeNull();
    });

    it('should return latest (first) version when selectedVersion is null', () => {
      const result = getSelectedVersionData(versionData, null);
      expect(result).toBe(versionData[0]);
      expect(result?.version).toBe(2);
    });

    it('should return specific version when selectedVersion is provided', () => {
      const result = getSelectedVersionData(versionData, 1);
      expect(result).toBe(versionData[1]);
      expect(result?.version).toBe(1);
    });

    it('should return latest version when requested version not found', () => {
      const result = getSelectedVersionData(versionData, 99);
      expect(result).toBe(versionData[0]);
      expect(result?.version).toBe(2);
    });
  });

  describe('getVersionTestCases', () => {
    const testCases: TestCase[] = [
      createMockTestCase('tc-1', 'Test Case 1'),
      createMockTestCase('tc-2', 'Test Case 2'),
      createMockTestCase('tc-3', 'Test Case 3'),
    ];

    it('should return empty array when selectedVersionData is null', () => {
      const result = getVersionTestCases(testCases, null);
      expect(result).toEqual([]);
    });

    it('should return test cases matching the version testCaseIds', () => {
      const versionData: VersionData = {
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-1', 'tc-3'],
        isLatest: true,
        added: [],
        removed: [],
        runCount: 0,
      };

      const result = getVersionTestCases(testCases, versionData);

      expect(result).toHaveLength(2);
      expect(result.map(tc => tc.id)).toEqual(['tc-1', 'tc-3']);
    });

    it('should return empty array when no test cases match', () => {
      const versionData: VersionData = {
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-99', 'tc-100'],
        isLatest: true,
        added: [],
        removed: [],
        runCount: 0,
      };

      const result = getVersionTestCases(testCases, versionData);

      expect(result).toEqual([]);
    });

    it('should handle empty test cases array', () => {
      const versionData: VersionData = {
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-1'],
        isLatest: true,
        added: [],
        removed: [],
        runCount: 0,
      };

      const result = getVersionTestCases([], versionData);

      expect(result).toEqual([]);
    });
  });

  describe('filterRunsByVersion', () => {
    const runs: BenchmarkRun[] = [
      createMockRun('run-1', 1, '2026-01-01T01:00:00Z'),
      createMockRun('run-2', 1, '2026-01-01T03:00:00Z'),
      createMockRun('run-3', 2, '2026-01-02T01:00:00Z'),
      createMockRun('run-4', 2, '2026-01-02T02:00:00Z'),
      createMockRun('run-5', 1, '2026-01-01T02:00:00Z'),
    ];

    it('should return empty array for undefined runs', () => {
      const result = filterRunsByVersion(undefined, 'all');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty runs', () => {
      const result = filterRunsByVersion([], 'all');
      expect(result).toEqual([]);
    });

    it('should return all runs sorted by date (newest first) when filter is "all"', () => {
      const result = filterRunsByVersion(runs, 'all');

      expect(result).toHaveLength(5);
      // Check sorted by createdAt descending
      expect(result[0].id).toBe('run-4'); // 2026-01-02T02:00:00Z
      expect(result[1].id).toBe('run-3'); // 2026-01-02T01:00:00Z
      expect(result[2].id).toBe('run-2'); // 2026-01-01T03:00:00Z
      expect(result[3].id).toBe('run-5'); // 2026-01-01T02:00:00Z
      expect(result[4].id).toBe('run-1'); // 2026-01-01T01:00:00Z
    });

    it('should filter runs by version 1', () => {
      const result = filterRunsByVersion(runs, 1);

      expect(result).toHaveLength(3);
      expect(result.every(r => r.benchmarkVersion === 1)).toBe(true);
      // Still sorted by date
      expect(result[0].id).toBe('run-2');
      expect(result[1].id).toBe('run-5');
      expect(result[2].id).toBe('run-1');
    });

    it('should filter runs by version 2', () => {
      const result = filterRunsByVersion(runs, 2);

      expect(result).toHaveLength(2);
      expect(result.every(r => r.benchmarkVersion === 2)).toBe(true);
      expect(result[0].id).toBe('run-4');
      expect(result[1].id).toBe('run-3');
    });

    it('should return empty array when no runs match the version', () => {
      const result = filterRunsByVersion(runs, 99);
      expect(result).toEqual([]);
    });

    it('should treat runs without benchmarkVersion as version 1', () => {
      const runsWithLegacy: BenchmarkRun[] = [
        ...runs,
        {
          id: 'run-legacy',
          name: 'Legacy Run',
          createdAt: '2026-01-03T01:00:00Z',
          agentKey: 'test-agent',
          modelId: 'test-model',
          // No benchmarkVersion
          results: {},
        } as BenchmarkRun,
      ];

      const result = filterRunsByVersion(runsWithLegacy, 1);

      // Legacy run should be included when filtering for version 1
      expect(result.some(r => r.id === 'run-legacy')).toBe(true);
      expect(result).toHaveLength(4);
    });

    it('should not mutate the original runs array', () => {
      const originalRuns = [...runs];
      const originalFirstId = runs[0].id;
      filterRunsByVersion(runs, 'all');

      expect(runs[0].id).toBe(originalFirstId);
      expect(runs.length).toBe(originalRuns.length);
    });
  });
});
