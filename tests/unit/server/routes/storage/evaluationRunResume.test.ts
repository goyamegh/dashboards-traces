/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for checkpoint-resume eligibility (computeResumableTestCaseIds).
 *
 * Resume semantics (RedKite-inspired): a test case is resumable iff its
 * result has NO persisted report. Anything with a reportId is a checkpoint
 * and must be preserved.
 */

import { computeResumableTestCaseIds, runLivenessAgeMs, runStaleAfterMs } from '@/server/routes/storage/evaluationRuns';

const snap = (id: string) => ({ id, version: 1, name: id });

describe('computeResumableTestCaseIds', () => {
  it('returns every snapshot id when there are no results yet', () => {
    const run = { testCaseSnapshots: [snap('a'), snap('b')], results: {} } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['a', 'b']);
  });

  it('skips test cases whose result has a persisted report', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b'), snap('c')],
      results: {
        a: { reportId: 'report-a', status: 'completed' },
        b: { reportId: '', status: 'pending' },
        // c has no entry at all (crashed before it was scheduled)
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['b', 'c']);
  });

  it('treats failed-WITH-report as done, failed-WITHOUT-report as resumable', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b')],
      results: {
        // Genuine agent failure — report persisted, verdict recorded. Keep it.
        a: { reportId: 'report-a', status: 'failed', error: 'agent errored' },
        // Interrupted by crash/recovery — no report. Re-run it.
        b: { reportId: '', status: 'failed', error: 'server died' },
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['b']);
  });

  it('treats interrupted running entries (no report) as resumable', () => {
    const run = {
      testCaseSnapshots: [snap('a')],
      results: { a: { reportId: '', status: 'running' } },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['a']);
  });

  it('returns empty when every test case has a report (nothing to resume)', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b')],
      results: {
        a: { reportId: 'r-a', status: 'completed' },
        b: { reportId: 'r-b', status: 'failed' },
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual([]);
  });

  it('handles missing snapshots/results defensively', () => {
    expect(computeResumableTestCaseIds({} as any)).toEqual([]);
    expect(computeResumableTestCaseIds({ testCaseSnapshots: [], results: undefined } as any)).toEqual([]);
  });
});

describe('run liveness (shared-cluster safety)', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');

  it('prefers heartbeatAt over resumedAt over createdAt', () => {
    const run = {
      createdAt: new Date(T0 - 3_600_000).toISOString(),
      resumedAt: new Date(T0 - 600_000).toISOString(),
      heartbeatAt: new Date(T0 - 30_000).toISOString(),
    };
    expect(runLivenessAgeMs(run, T0)).toBe(30_000);
    expect(runLivenessAgeMs({ ...run, heartbeatAt: undefined }, T0)).toBe(600_000);
    expect(runLivenessAgeMs({ createdAt: run.createdAt }, T0)).toBe(3_600_000);
  });

  it('treats missing/invalid timestamps as infinitely stale', () => {
    expect(runLivenessAgeMs({} as any, T0)).toBe(Infinity);
    expect(runLivenessAgeMs({ createdAt: 'not-a-date' } as any, T0)).toBe(Infinity);
  });

  it('stale threshold defaults to 1h and honors EVALUATION_RUN_STALE_AFTER_MS', () => {
    const prev = process.env.EVALUATION_RUN_STALE_AFTER_MS;
    delete process.env.EVALUATION_RUN_STALE_AFTER_MS;
    expect(runStaleAfterMs()).toBe(3_600_000);
    process.env.EVALUATION_RUN_STALE_AFTER_MS = '5000';
    expect(runStaleAfterMs()).toBe(5000);
    process.env.EVALUATION_RUN_STALE_AFTER_MS = '-1';
    expect(runStaleAfterMs()).toBe(3_600_000);
    if (prev === undefined) delete process.env.EVALUATION_RUN_STALE_AFTER_MS;
    else process.env.EVALUATION_RUN_STALE_AFTER_MS = prev;
  });
});
