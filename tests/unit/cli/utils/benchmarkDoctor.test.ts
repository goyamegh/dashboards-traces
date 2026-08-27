/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeBenchmarkRepairPlan, applyRepairPlan } from '@/cli/utils/benchmarkDoctor';
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
    // Mirrors bench-1787626453329-ofvke6py4 / eval-run-1787626454913-t6pvidos0 /
    // tc-1787626454108-cv8vh139u from the dogfood finding.
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
