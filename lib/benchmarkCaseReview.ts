/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the benchmark case-review matrix.
 *
 * The benchmark document supplies the canonical run/case relationship, while
 * lightweight report summaries supply the actual pass/fail/error verdicts.
 * Keeping this logic outside React makes the bucket priority and pager order
 * deterministic (and cheap to test) for suites with hundreds of cases.
 */

export type CaseVerdict = 'passed' | 'failed' | 'errored' | 'not-run';
export type CaseReviewBucket = 'needs-attention' | 'flaky' | 'stable' | 'no-data';
export type CaseReviewFilter = 'all' | Exclude<CaseReviewBucket, 'no-data'>;
export type SwipeDirection = 'prev' | 'next';

const MIN_SWIPE_DISTANCE = 48;
const HORIZONTAL_SWIPE_RATIO = 1.5;
const PAGER_DRAG_SLOP = 10;
const PAGER_EDGE_RESISTANCE = 0.35;

export interface PagerDragInput {
  dx: number;
  dy: number;
  latched: boolean;
  atStart: boolean;
  atEnd: boolean;
}

export interface PagerDragResult {
  offset: number;
  latched: boolean;
}

/**
 * Latch a horizontal pager drag after a small slop, then preserve that latch
 * for the rest of the gesture. Pulling beyond either end receives resistance
 * so the pane communicates the boundary without changing cases.
 *
 * Reduced-motion behavior intentionally stays out of this geometry helper;
 * callers suppress the returned offset while retaining gesture navigation.
 */
export function computePagerDrag({
  dx,
  dy,
  latched,
  atStart,
  atEnd,
}: PagerDragInput): PagerDragResult {
  const nextLatched = latched || (
    Math.abs(dx) > PAGER_DRAG_SLOP &&
    Math.abs(dx) > Math.abs(dy)
  );
  if (!nextLatched) return { offset: 0, latched: false };

  const beyondStart = atStart && dx > 0;
  const beyondEnd = atEnd && dx < 0;
  return {
    offset: (beyondStart || beyondEnd) ? dx * PAGER_EDGE_RESISTANCE : dx,
    latched: true,
  };
}

/**
 * Resolve a completed gesture without suppressing native touch movement. A
 * negative x displacement is a left swipe (next); a positive one is previous.
 */
export function resolveSwipeDirection(
  dx: number,
  dy: number,
  touchCount = 1,
): SwipeDirection | null {
  if (touchCount !== 1) return null;
  if (Math.abs(dx) < MIN_SWIPE_DISTANCE) return null;
  if (Math.abs(dx) < HORIZONTAL_SWIPE_RATIO * Math.abs(dy)) return null;
  return dx < 0 ? 'next' : 'prev';
}

export interface VerdictReportSummary {
  status?: string;
  passFailStatus?: 'passed' | 'failed' | null;
  metricsStatus?: string;
}

export interface VerdictRunResult {
  reportId?: string;
  status?: string;
  /** Present on newer embedded benchmark results; reports remain authoritative. */
  passFailStatus?: 'passed' | 'failed';
}

export interface VerdictRun {
  id: string;
  createdAt: string;
  status?: string;
  results?: Record<string, VerdictRunResult>;
}

export interface ReviewableCase {
  id: string;
  name: string;
  prompt?: string;
}

export interface CaseReviewRow<T extends ReviewableCase = ReviewableCase> {
  testCase: T;
  verdicts: CaseVerdict[];
  bucket: CaseReviewBucket;
  passRate: number | null;
}

/** A legacy run with no top-level status is complete once all results are terminal. */
export function isCompletedVerdictRun(run: VerdictRun): boolean {
  if (run.status) return run.status === 'completed';
  const results = Object.values(run.results || {});
  return results.length > 0 && results.every(result =>
    result.status !== 'pending' && result.status !== 'running'
  );
}

export function getRecentCompletedRuns<T extends VerdictRun>(runs: T[], limit = 5): T[] {
  return [...runs]
    .filter(isCompletedVerdictRun)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Resolve one case×run cell. A real pass/fail verdict from the report is
 * authoritative and outranks `metricsStatus === 'error'`: metrics/cost
 * enrichment runs after the agent-vs-judge verdict is already known, so a
 * later enrichment failure must not overwrite a genuine pass/fail with
 * 'errored'. `metricsStatus === 'error'` only decides the cell when the
 * report has no real passFailStatus yet.
 */
export function deriveCaseVerdict(
  run: VerdictRun,
  testCaseId: string,
  reportsById: Record<string, VerdictReportSummary | undefined>,
): CaseVerdict {
  const result = run.results?.[testCaseId];
  if (!result || result.status === 'pending' || result.status === 'running') return 'not-run';

  const report = result.reportId ? reportsById[result.reportId] : undefined;
  if (report?.passFailStatus === 'passed') return 'passed';
  if (report?.passFailStatus === 'failed') return 'failed';
  if (report?.metricsStatus === 'error') return 'errored';

  // New benchmark documents carry this summary. It is a resilience fallback
  // for deleted/legacy report documents, not the primary source of truth.
  if (result.passFailStatus === 'passed') return 'passed';
  if (result.passFailStatus === 'failed') return 'failed';

  if (result.status === 'failed' || result.status === 'cancelled' || report?.status === 'failed') {
    return 'failed';
  }

  // A completed result without a verdict means the evaluator did not produce
  // a usable score. Keep it visually/semantically separate from agent failure.
  if (result.status === 'completed') return 'errored';
  return 'not-run';
}

export function deriveCaseVerdicts(
  runs: VerdictRun[],
  testCaseId: string,
  reportsById: Record<string, VerdictReportSummary | undefined>,
): CaseVerdict[] {
  return runs.map(run => deriveCaseVerdict(run, testCaseId, reportsById));
}

/**
 * Buckets are disjoint by priority. Evaluator errors require attention but do
 * not become failed verdicts or enter the pass-rate denominator.
 */
export function classifyCaseVerdicts(verdicts: CaseVerdict[]): CaseReviewBucket {
  const observed = verdicts.filter(verdict => verdict !== 'not-run');
  if (observed.length === 0) return 'no-data';

  const latestThree = verdicts.slice(0, 3);
  if (latestThree.some(verdict => verdict === 'failed' || verdict === 'errored')) {
    return 'needs-attention';
  }

  const scored = verdicts.filter(verdict => verdict === 'passed' || verdict === 'failed');
  const hasPass = scored.includes('passed');
  const hasFail = scored.includes('failed');
  if (hasPass && hasFail) return 'flaky';
  if (hasPass) return 'stable';

  // Sparse histories can put an old failure/error outside the last-three
  // window. They still have data and are not passing, so attention is the only
  // honest bucket.
  return 'needs-attention';
}

export function getCasePassRate(verdicts: CaseVerdict[]): number | null {
  const passed = verdicts.filter(verdict => verdict === 'passed').length;
  const failed = verdicts.filter(verdict => verdict === 'failed').length;
  return passed + failed === 0 ? null : passed / (passed + failed);
}

export function buildCaseReviewRows<T extends ReviewableCase>(
  testCases: T[],
  recentRuns: VerdictRun[],
  reportsById: Record<string, VerdictReportSummary | undefined>,
): CaseReviewRow<T>[] {
  return testCases.map(testCase => {
    const verdicts = deriveCaseVerdicts(recentRuns, testCase.id, reportsById);
    return {
      testCase,
      verdicts,
      bucket: classifyCaseVerdicts(verdicts),
      passRate: getCasePassRate(verdicts),
    };
  });
}

/** Search/filter first, then pass-rate ascending; no-data sorts last. */
export function filterAndSortCaseRows<T extends ReviewableCase>(
  rows: CaseReviewRow<T>[],
  search: string,
  filter: CaseReviewFilter,
): CaseReviewRow<T>[] {
  const query = search.trim().toLocaleLowerCase();
  return rows
    .filter(row => filter === 'all' || row.bucket === filter)
    .filter(row => !query ||
      row.testCase.name.toLocaleLowerCase().includes(query) ||
      (row.testCase.prompt || '').toLocaleLowerCase().includes(query)
    )
    .sort((a, b) => {
      if (a.passRate === null && b.passRate !== null) return 1;
      if (a.passRate !== null && b.passRate === null) return -1;
      if (a.passRate !== null && b.passRate !== null && a.passRate !== b.passRate) {
        return a.passRate - b.passRate;
      }
      return a.testCase.name.localeCompare(b.testCase.name);
    });
}

export function getCasePagerPosition<T extends ReviewableCase>(
  rows: CaseReviewRow<T>[],
  selectedCaseId: string | undefined,
): { index: number; position: number; total: number; previousId?: string; nextId?: string } {
  const index = selectedCaseId ? rows.findIndex(row => row.testCase.id === selectedCaseId) : -1;
  return {
    index,
    position: index >= 0 ? index + 1 : 0,
    total: rows.length,
    previousId: index > 0 ? rows[index - 1].testCase.id : undefined,
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].testCase.id : undefined,
  };
}

export interface VersionedRunResult {
  reportId?: string;
}

export interface VersionedRun {
  results?: Record<string, VersionedRunResult>;
}

export interface VersionedReportSummary {
  testCaseVersion?: number;
}

/**
 * The Cases tab always renders a case's *current* definition, even when the
 * user arrived from a specific historical run (e.g. a heat-strip cell click).
 * This detects that mismatch so callers can show a minimal, honest notice
 * instead of silently presenting a definition the run never actually used.
 * Deliberately does not resurrect the old per-version selector — just a
 * disclosure that the definition may have changed since some of the runs
 * shown here.
 */
export function hasHistoricalVersionMismatch(
  currentVersion: number,
  runs: VersionedRun[],
  testCaseId: string,
  reportsById: Record<string, VersionedReportSummary | undefined>,
): boolean {
  return runs.some(run => {
    const result = run.results?.[testCaseId];
    const report = result?.reportId ? reportsById[result.reportId] : undefined;
    return typeof report?.testCaseVersion === 'number' && report.testCaseVersion !== currentVersion;
  });
}
