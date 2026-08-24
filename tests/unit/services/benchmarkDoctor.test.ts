/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildDoctorPlan } from '@/services/benchmarkDoctor';
import type { Benchmark, EvaluationRun } from '@/types';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z'; // way older than 24h
const FRESH = '2026-05-31T23:30:00.000Z'; // 30 min old

function bench(overrides: Partial<Benchmark> & { id: string; name: string }): Benchmark {
  return {
    description: '',
    createdAt: OLD,
    updatedAt: OLD,
    currentVersion: 1,
    versions: [],
    testCaseIds: [],
    runs: [],
    ...overrides,
  } as Benchmark;
}

function run(id: string, benchmarkId?: string): EvaluationRun {
  return {
    id,
    docType: 'evaluation-run',
    name: id,
    createdAt: OLD,
    status: 'completed',
    agentKey: 'a',
    modelId: 'm',
    sources: [],
    trigger: 'cli',
    testCaseSnapshots: [],
    results: {},
    ...(benchmarkId ? { benchmarkId } : {}),
  } as EvaluationRun;
}

describe('buildDoctorPlan — debris detection', () => {
  it('flags quick-<ts> and *-<epoch-ms> benchmarks with no runs anywhere', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767' }),
        bench({ id: 'b2', name: 'sdk-cli-coverage-1787518298767' }),
        bench({ id: 'b3', name: 'My Real Benchmark' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions.map((d) => d.id).sort()).toEqual(['b1', 'b2']);
  });

  it('never flags debris that has embedded runs or eval-run references', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767', runs: [{ id: 'r' } as any] }),
        bench({ id: 'b2', name: 'quick-1787518298768' }),
      ],
      [run('er-1', 'b2')],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
  });

  it('never flags debris younger than 24h (in-flight shells are safe)', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'b1', name: 'quick-1787518298767', createdAt: FRESH })],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
  });

  it('never touches sample data', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'demo-quick', name: 'quick-1787518298767' })],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
    expect(plan.summary.totalBenchmarks).toBe(0);
  });
});

describe('buildDoctorPlan — content duplicates', () => {
  it('groups benchmarks with the same testCaseIds set (order-insensitive)', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'A', testCaseIds: ['tc-1', 'tc-2'] }),
        bench({ id: 'b2', name: 'A copy', testCaseIds: ['tc-2', 'tc-1'] }),
        bench({ id: 'b3', name: 'Different', testCaseIds: ['tc-3'] }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups).toHaveLength(1);
    expect(plan.contentDupGroups[0].husks).toHaveLength(1);
  });

  it('empty test-case sets are never treated as "same content"', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'Shell A' }),
        bench({ id: 'b2', name: 'Shell B' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups).toEqual([]);
  });

  it('canonical is the member with most embedded runs, then refs, then oldest', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b-old', name: 'oldest', testCaseIds: ['tc-1'], createdAt: '2025-01-01T00:00:00.000Z' }),
        bench({ id: 'b-runs', name: 'has runs', testCaseIds: ['tc-1'], runs: [{ id: 'r1' } as any] }),
        bench({ id: 'b-new', name: 'newest', testCaseIds: ['tc-1'], createdAt: '2026-05-01T00:00:00.000Z' }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.contentDupGroups[0].canonicalId).toBe('b-runs');
    expect(plan.contentDupGroups[0].husks.map((h) => h.id).sort()).toEqual(['b-new', 'b-old']);
  });

  it('plans re-points for eval-runs referencing husks', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'canonical', testCaseIds: ['tc-1'], runs: [{ id: 'r1' } as any] }),
        bench({ id: 'b2', name: 'husk', testCaseIds: ['tc-1'] }),
      ],
      [run('er-1', 'b2'), run('er-2', 'b2'), run('er-3', 'b1')],
      { now: NOW }
    );
    const group = plan.contentDupGroups[0];
    expect(group.canonicalId).toBe('b1');
    expect(group.runRepoints).toEqual([
      { runId: 'er-1', fromBenchmarkId: 'b2', toBenchmarkId: 'b1' },
      { runId: 'er-2', fromBenchmarkId: 'b2', toBenchmarkId: 'b1' },
    ]);
    expect(plan.summary.runsToRepoint).toBe(2);
  });

  it('a debris deletion removes the doc from dup grouping (no double-handling)', () => {
    const plan = buildDoctorPlan(
      [
        bench({ id: 'b1', name: 'quick-1787518298767', testCaseIds: ['tc-1'] }),
        bench({ id: 'b2', name: 'real', testCaseIds: ['tc-1'] }),
      ],
      [],
      { now: NOW }
    );
    expect(plan.debrisDeletions.map((d) => d.id)).toEqual(['b1']);
    expect(plan.contentDupGroups).toEqual([]); // b2 alone is not a group
  });
});

describe('buildDoctorPlan — clean state', () => {
  it('returns an empty plan when nothing is wrong', () => {
    const plan = buildDoctorPlan(
      [bench({ id: 'b1', name: 'Healthy', testCaseIds: ['tc-1'] })],
      [run('er-1', 'b1')],
      { now: NOW }
    );
    expect(plan.debrisDeletions).toEqual([]);
    expect(plan.contentDupGroups).toEqual([]);
    expect(plan.summary).toEqual({
      totalBenchmarks: 1,
      debrisCount: 0,
      dupGroupCount: 0,
      husksToMerge: 0,
      runsToRepoint: 0,
    });
  });
});
