/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildCaseReviewRows,
  classifyCaseVerdicts,
  computePagerDrag,
  deriveCaseVerdict,
  filterAndSortCaseRows,
  getCasePagerPosition,
  getCasePassRate,
  getRecentCompletedRuns,
  hasHistoricalVersionMismatch,
  resolveSwipeDirection,
  type CaseReviewRow,
  type ReviewableCase,
  type VerdictRun,
  type VersionedRun,
} from '@/lib/benchmarkCaseReview';

function run(
  id: string,
  createdAt: string,
  results: VerdictRun['results'],
  status = 'completed',
): VerdictRun {
  return { id, createdAt, status, results };
}

describe('benchmark case-review verdicts', () => {
  it('classifies attention, flaky, stable, errored, and never-run histories by priority', () => {
    expect(classifyCaseVerdicts(['passed', 'failed', 'passed'])).toBe('needs-attention');
    expect(classifyCaseVerdicts(['passed', 'passed', 'passed', 'failed', 'passed'])).toBe('flaky');
    expect(classifyCaseVerdicts(['passed', 'not-run', 'passed'])).toBe('stable');

    // An evaluator error needs operator attention but remains distinct from a
    // failed agent verdict and does not count toward pass rate.
    expect(classifyCaseVerdicts(['errored', 'passed'])).toBe('needs-attention');
    expect(getCasePassRate(['errored', 'passed'])).toBe(1);
    expect(getCasePassRate(['errored', 'not-run'])).toBeNull();
    expect(classifyCaseVerdicts(['not-run', 'not-run'])).toBe('no-data');
  });

  it('derives sparkline and heat-strip cells from report verdict documents', () => {
    const completed = run('r1', '2025-01-05T00:00:00Z', {
      pass: { reportId: 'rp', status: 'completed' },
      fail: { reportId: 'rf', status: 'completed' },
      error: { reportId: 're', status: 'completed' },
      executionFailure: { reportId: 'rx', status: 'failed' },
    });
    const reports = {
      rp: { passFailStatus: 'passed' as const },
      rf: { passFailStatus: 'failed' as const },
      // No real passFailStatus yet: metricsStatus === 'error' is the only signal.
      re: { metricsStatus: 'error' },
      rx: { status: 'failed' },
    };

    expect(deriveCaseVerdict(completed, 'pass', reports)).toBe('passed');
    expect(deriveCaseVerdict(completed, 'fail', reports)).toBe('failed');
    expect(deriveCaseVerdict(completed, 'error', reports)).toBe('errored');
    expect(deriveCaseVerdict(completed, 'executionFailure', reports)).toBe('failed');
    expect(deriveCaseVerdict(completed, 'missing', reports)).toBe('not-run');
  });

  it('precedence: a real passFailStatus outranks metricsStatus === "error"', () => {
    // A later metrics/cost-enrichment pass can fail well after the agent-vs-judge
    // verdict is already known. That enrichment failure must never overwrite a
    // genuine pass/fail with 'errored' -- see PR #447 review discussion.
    const completed = run('r1', '2025-01-05T00:00:00Z', {
      passWithMetricsError: { reportId: 'rpe', status: 'completed' },
      failWithMetricsError: { reportId: 'rfe', status: 'completed' },
      errorOnly: { reportId: 'reo', status: 'completed' },
    });
    const reports = {
      rpe: { passFailStatus: 'passed' as const, metricsStatus: 'error' },
      rfe: { passFailStatus: 'failed' as const, metricsStatus: 'error' },
      reo: { metricsStatus: 'error' },
    };

    expect(deriveCaseVerdict(completed, 'passWithMetricsError', reports)).toBe('passed');
    expect(deriveCaseVerdict(completed, 'failWithMetricsError', reports)).toBe('failed');
    expect(deriveCaseVerdict(completed, 'errorOnly', reports)).toBe('errored');
  });

  it('uses only the five newest completed runs and preserves newest-first cell order', () => {
    const runs: VerdictRun[] = [
      run('old', '2025-01-01T00:00:00Z', { c1: { reportId: 'old', status: 'completed' } }),
      run('new', '2025-01-07T00:00:00Z', { c1: { reportId: 'new', status: 'completed' } }),
      run('mid', '2025-01-05T00:00:00Z', { c1: { reportId: 'mid', status: 'completed' } }),
      run('running', '2025-01-08T00:00:00Z', { c1: { reportId: 'running', status: 'running' } }, 'running'),
      run('four', '2025-01-04T00:00:00Z', { c1: { reportId: 'four', status: 'completed' } }),
      run('three', '2025-01-03T00:00:00Z', { c1: { reportId: 'three', status: 'completed' } }),
      run('six', '2025-01-06T00:00:00Z', { c1: { reportId: 'six', status: 'completed' } }),
      run('two', '2025-01-02T00:00:00Z', { c1: { reportId: 'two', status: 'completed' } }),
    ];

    const recent = getRecentCompletedRuns(runs);
    expect(recent.map(item => item.id)).toEqual(['new', 'six', 'mid', 'four', 'three']);

    const rows = buildCaseReviewRows(
      [{ id: 'c1', name: 'Case one', prompt: 'Investigate' }],
      recent,
      {
        new: { passFailStatus: 'failed' },
        six: { passFailStatus: 'passed' },
        mid: { metricsStatus: 'error' },
        four: { passFailStatus: 'passed' },
        three: { passFailStatus: 'failed' },
      },
    );
    expect(rows[0].verdicts).toEqual(['failed', 'passed', 'errored', 'passed', 'failed']);
  });
});

describe('benchmark case-review swipe navigation', () => {
  it('latches pager drag only after crossing the horizontal slop boundary', () => {
    expect(computePagerDrag({
      dx: 10, dy: 0, latched: false, atStart: false, atEnd: false,
    })).toEqual({ offset: 0, latched: false });
    expect(computePagerDrag({
      dx: 10.01, dy: 0, latched: false, atStart: false, atEnd: false,
    })).toEqual({ offset: 10.01, latched: true });
  });

  it('requires horizontal dominance to latch and preserves an existing latch', () => {
    expect(computePagerDrag({
      dx: -24, dy: 24, latched: false, atStart: false, atEnd: false,
    })).toEqual({ offset: 0, latched: false });
    expect(computePagerDrag({
      dx: -24, dy: 23.99, latched: false, atStart: false, atEnd: false,
    })).toEqual({ offset: -24, latched: true });
    expect(computePagerDrag({
      dx: -8, dy: 40, latched: true, atStart: false, atEnd: false,
    })).toEqual({ offset: -8, latched: true });
  });

  it('applies 0.35 resistance only while pulling beyond a pager edge', () => {
    expect(computePagerDrag({
      dx: 100, dy: 0, latched: false, atStart: true, atEnd: false,
    }).offset).toBeCloseTo(35);
    expect(computePagerDrag({
      dx: -100, dy: 0, latched: false, atStart: false, atEnd: true,
    }).offset).toBeCloseTo(-35);
    expect(computePagerDrag({
      dx: -100, dy: 0, latched: false, atStart: true, atEnd: false,
    }).offset).toBe(-100);
  });

  it('keeps drag geometry independent of reduced-motion presentation', () => {
    const drag = computePagerDrag({
      dx: -80, dy: 2, latched: false, atStart: false, atEnd: false,
    });
    // The component renders zero offset for reduced motion; gesture geometry
    // remains available so touchend can still resolve navigation.
    expect(drag).toEqual({ offset: -80, latched: true });
    expect({ ...drag, offset: 0 }).toEqual({ offset: 0, latched: true });
  });

  it('accepts the distance and horizontal-ratio boundaries', () => {
    expect(resolveSwipeDirection(-48, 32)).toBe('next');
    expect(resolveSwipeDirection(48, -32)).toBe('prev');
    expect(resolveSwipeDirection(47.99, 0)).toBeNull();
  });

  it('rejects vertical-dominant movement', () => {
    expect(resolveSwipeDirection(-100, 67)).toBeNull();
    expect(resolveSwipeDirection(80, 80)).toBeNull();
  });

  it('ignores multi-touch gestures', () => {
    expect(resolveSwipeDirection(-200, 0, 2)).toBeNull();
  });
});

describe('benchmark case-review filtered pager', () => {
  const reviewCase = (id: string, name: string, prompt: string): ReviewableCase => ({ id, name, prompt });
  const row = (
    testCase: ReviewableCase,
    passRate: number | null,
    bucket: CaseReviewRow['bucket'],
  ): CaseReviewRow => ({ testCase, passRate, bucket, verdicts: [] });

  const rows = [
    row(reviewCase('stable', 'Zulu stable', 'routine check'), 1, 'stable'),
    row(reviewCase('attention-b', 'Beta failure', 'database timeout'), 0, 'needs-attention'),
    row(reviewCase('attention-a', 'Alpha failure', 'network timeout'), 0, 'needs-attention'),
    row(reviewCase('flaky', 'Gamma flaky', 'network retry'), 0.5, 'flaky'),
    row(reviewCase('no-data', 'Never run', 'network fixture'), null, 'no-data'),
  ];

  it('searches name+prompt, filters buckets, and sorts by pass rate then name', () => {
    expect(filterAndSortCaseRows(rows, '', 'all').map(item => item.testCase.id)).toEqual([
      'attention-a', 'attention-b', 'flaky', 'stable', 'no-data',
    ]);
    expect(filterAndSortCaseRows(rows, 'network', 'all').map(item => item.testCase.id)).toEqual([
      'attention-a', 'flaky', 'no-data',
    ]);
    expect(filterAndSortCaseRows(rows, '', 'needs-attention').map(item => item.testCase.id)).toEqual([
      'attention-a', 'attention-b',
    ]);
  });

  it('pages over the current filtered and sorted list', () => {
    const filtered = filterAndSortCaseRows(rows, 'network', 'all');
    expect(getCasePagerPosition(filtered, 'flaky')).toEqual({
      index: 1,
      position: 2,
      total: 3,
      previousId: 'attention-a',
      nextId: 'no-data',
    });
  });
});

describe('historical case-version notice', () => {
  const runWithReport = (reportId: string): VersionedRun => ({
    results: { c1: { reportId } },
  });

  it('flags a mismatch when a run\'s report used a different case version', () => {
    const reportsById = { r1: { testCaseVersion: 2 } };
    expect(hasHistoricalVersionMismatch(3, [runWithReport('r1')], 'c1', reportsById)).toBe(true);
  });

  it('does not flag when every report matches the current version', () => {
    const reportsById = { r1: { testCaseVersion: 3 }, r2: { testCaseVersion: 3 } };
    expect(hasHistoricalVersionMismatch(3, [runWithReport('r1'), runWithReport('r2')], 'c1', reportsById)).toBe(false);
  });

  it('does not flag when the report has no recorded version (legacy data)', () => {
    const reportsById = { r1: {} };
    expect(hasHistoricalVersionMismatch(3, [runWithReport('r1')], 'c1', reportsById)).toBe(false);
  });

  it('ignores runs with no result or report for this case', () => {
    expect(hasHistoricalVersionMismatch(3, [{ results: {} }, { results: undefined }], 'c1', {})).toBe(false);
  });
});
