/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeBenchmarkRepairPlan,
  applyRepairPlan,
  computeVersionLinkRepairPlan,
} from '@/cli/utils/benchmarkDoctor';
import type { Benchmark, EvaluationRun } from '@/types';

function benchmark(overrides: Partial<Benchmark> = {}): Pick<Benchmark, 'id' | 'name' | 'testCaseIds'> {
  return {
    id: 'bench-1',
    name: 'Test Benchmark',
    testCaseIds: [],
    ...overrides,
  };
}

function evalRun(
  overrides: Partial<Pick<EvaluationRun, 'id' | 'benchmarkId' | 'testCaseSnapshots'>> = {}
): Pick<EvaluationRun, 'id' | 'benchmarkId' | 'testCaseSnapshots'> {
  return {
    id: 'eval-run-1',
    benchmarkId: 'bench-1',
    testCaseSnapshots: [],
    ...overrides,
  };
}

describe('computeBenchmarkRepairPlan', () => {
  it('returns null when there are no evaluation runs', () => {
    expect(computeBenchmarkRepairPlan(benchmark(), [])).toBeNull();
  });

  it('returns null when the benchmark already has every referenced test case id', () => {
    const bm = benchmark({ testCaseIds: ['tc-1', 'tc-2'] });
    const run = evalRun({ testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'a' }] });
    expect(computeBenchmarkRepairPlan(bm, [run])).toBeNull();
  });

  it('detects the exact dogfood shape: shell benchmark (testCaseIds: []) with a linked run', () => {
    const bm = benchmark({ id: 'bench-1787626453329-ofvke6py4', testCaseIds: [] });
    const run = evalRun({
      id: 'eval-run-1787626454913-t6pvidos0',
      benchmarkId: bm.id,
      testCaseSnapshots: [{ id: 'tc-1787626454108-cv8vh139u', version: 1, name: 'cost eval' }],
    });

    const plan = computeBenchmarkRepairPlan(bm, [run]);

    expect(plan).toEqual({
      benchmarkId: 'bench-1787626453329-ofvke6py4',
      benchmarkName: 'Test Benchmark',
      missingTestCaseIds: ['tc-1787626454108-cv8vh139u'],
      affectedRunIds: ['eval-run-1787626454913-t6pvidos0'],
    });
  });

  it('collects missing ids across multiple runs without duplicates', () => {
    const bm = benchmark({ testCaseIds: ['tc-1'] });
    const runs = [
      evalRun({ id: 'run-a', testCaseSnapshots: [{ id: 'tc-2', version: 1, name: 'a' }] }),
      evalRun({ id: 'run-b', testCaseSnapshots: [{ id: 'tc-2', version: 1, name: 'a' }, { id: 'tc-3', version: 1, name: 'b' }] }),
    ];

    const plan = computeBenchmarkRepairPlan(bm, runs);

    expect(plan?.missingTestCaseIds.sort()).toEqual(['tc-2', 'tc-3']);
    expect(plan?.affectedRunIds.sort()).toEqual(['run-a', 'run-b']);
  });

  it('ignores runs that reference a different benchmarkId', () => {
    const bm = benchmark({ id: 'bench-1', testCaseIds: [] });
    const run = evalRun({ benchmarkId: 'some-other-bench', testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'a' }] });
    expect(computeBenchmarkRepairPlan(bm, [run])).toBeNull();
  });

  it('ignores runs with no testCaseSnapshots', () => {
    const bm = benchmark({ testCaseIds: [] });
    const run = evalRun({ testCaseSnapshots: [] });
    expect(computeBenchmarkRepairPlan(bm, [run])).toBeNull();
  });
});

describe('applyRepairPlan', () => {
  it('appends missing ids to the existing testCaseIds', () => {
    const plan = { benchmarkId: 'b', benchmarkName: 'B', missingTestCaseIds: ['tc-2', 'tc-3'], affectedRunIds: [] };
    expect(applyRepairPlan(['tc-1'], plan)).toEqual(['tc-1', 'tc-2', 'tc-3']);
  });

  it('does not duplicate an id that is already present', () => {
    const plan = { benchmarkId: 'b', benchmarkName: 'B', missingTestCaseIds: ['tc-1', 'tc-2'], affectedRunIds: [] };
    expect(applyRepairPlan(['tc-1'], plan)).toEqual(['tc-1', 'tc-2']);
  });

  it('handles an empty existing list', () => {
    const plan = { benchmarkId: 'b', benchmarkName: 'B', missingTestCaseIds: ['tc-1'], affectedRunIds: [] };
    expect(applyRepairPlan([], plan)).toEqual(['tc-1']);
  });
});

/**
 * computeVersionLinkRepairPlan: the "stale version" planner behind
 * `benchmark repair-links`'s version-level backfill. Detects when the
 * CURRENT version's own `testCaseIds` entry (what the benchmark page's
 * test-case panel reads) is missing ids the top level already has —
 * independent of any linked run.
 */
describe('computeVersionLinkRepairPlan', () => {
  function bm(overrides: Partial<Pick<Benchmark, 'id' | 'name' | 'testCaseIds' | 'currentVersion' | 'versions'>> = {}) {
    return {
      id: 'bench-1',
      name: 'Test Benchmark',
      testCaseIds: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: [] }],
      ...overrides,
    };
  }

  it('returns null when top-level testCaseIds is empty', () => {
    expect(computeVersionLinkRepairPlan(bm({ testCaseIds: [] }))).toBeNull();
  });

  it('returns null when there are no versions to check against', () => {
    expect(computeVersionLinkRepairPlan(bm({ testCaseIds: ['tc-1'], versions: [] }))).toBeNull();
  });

  it('returns null when the current version already has every top-level id', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1', 'tc-2'] }],
    }));
    expect(plan).toBeNull();
  });

  it('detects the exact dogfood shape: top-level has ids, current version (v1) is empty', () => {
    // Mirrors bench-1787782179901-c1h0eld64: testCaseIds (top level) has 3
    // ids, currentVersion: 1, versions[0].testCaseIds == [].
    const plan = computeVersionLinkRepairPlan(bm({
      id: 'bench-1787782179901-c1h0eld64',
      testCaseIds: ['tc-1787782533401-8i34lcu4u', 'tc-1787782534314-azbp4n9v1', 'tc-1787782535312-dqlq6w85o'],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-08-26T22:09:39.901Z', testCaseIds: [] }],
    }));

    expect(plan).toEqual({
      benchmarkId: 'bench-1787782179901-c1h0eld64',
      benchmarkName: 'Test Benchmark',
      currentVersion: 1,
      missingTestCaseIds: ['tc-1787782533401-8i34lcu4u', 'tc-1787782534314-azbp4n9v1', 'tc-1787782535312-dqlq6w85o'],
      needsManualReview: false,
    });
  });

  it('only flags ids missing from the current version, not ones it already has', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] }],
    }));

    expect(plan?.missingTestCaseIds).toEqual(['tc-2', 'tc-3']);
  });

  it('checks the entry matching currentVersion, not array index 0', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 2,
      versions: [
        { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] }, // healthy, but not current
        { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: [] },        // current, stale
      ],
    }));

    expect(plan).toEqual({
      benchmarkId: 'bench-1',
      benchmarkName: 'Test Benchmark',
      currentVersion: 2,
      missingTestCaseIds: ['tc-1', 'tc-2'],
      // Two versions present -> flagged, NOT auto-fixable (see the dedicated
      // needsManualReview describe block below for why).
      needsManualReview: true,
    });
  });

  it('falls back to the last version entry when currentVersion does not match any entry (malformed doc)', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 99,
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] }],
    }));

    expect(plan?.missingTestCaseIds).toEqual(['tc-2']);
    expect(plan?.currentVersion).toBe(1);
  });
});

/**
 * needsManualReview: codex_review flagged that neither planner is
 * version-aware -- computeBenchmarkRepairPlan unions every linked run's
 * snapshot ids into the TOP LEVEL regardless of which version was current
 * when that run happened, so once a benchmark has more than one version,
 * blindly copying the top level into the CURRENT version (as --apply does)
 * risks mixing an older version's test cases into the current one. This is
 * the guard that makes that unsafe case explicit instead of silent.
 */
describe('computeVersionLinkRepairPlan — needsManualReview', () => {
  function bm(overrides: Partial<Pick<Benchmark, 'id' | 'name' | 'testCaseIds' | 'currentVersion' | 'versions'>> = {}) {
    return {
      id: 'bench-1',
      name: 'Test Benchmark',
      testCaseIds: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: [] }],
      ...overrides,
    };
  }

  it('is false for a single-version benchmark (the common CLI-shell case)', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1'],
      versions: [{ version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: [] }],
    }));
    expect(plan?.needsManualReview).toBe(false);
  });

  it('is true once the benchmark has more than one version, even if the current one is the stale one', () => {
    const plan = computeVersionLinkRepairPlan(bm({
      testCaseIds: ['tc-1', 'tc-2'],
      currentVersion: 2,
      versions: [
        { version: 1, createdAt: '2026-01-01T00:00:00Z', testCaseIds: ['tc-1'] },
        { version: 2, createdAt: '2026-01-02T00:00:00Z', testCaseIds: [] },
      ],
    }));
    expect(plan?.needsManualReview).toBe(true);
  });
});
