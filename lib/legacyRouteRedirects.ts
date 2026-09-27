/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Legacy (pre-evals3) route → evals3 route redirect table.
 *
 * The sidebar has only linked to `/evaluations/*` for a long time, but the
 * pre-evals3 pages (`/benchmarks`, `/benchmarks/:id/runs`, `/runs/:id`,
 * `/test-cases`, …) and the older evals3 run-detail page
 * (`/evaluations/runs/:id`, superseded by the run inspector at
 * `…/inspect`) stayed mounted and reachable by deep link — two UIs for the
 * same data, drifting apart. Every one of those routes now resolves to its
 * evals3 equivalent via `<Navigate replace>`; the components behind them
 * are deleted.
 *
 * `pattern` uses react-router path syntax; `to` is a template over the same
 * `:param` names. The query string is carried over untouched so deep links
 * like `?reportId=<id>` keep working on the inspector.
 *
 * NOTE: `/runs/:runId` is deliberately NOT in this table — that legacy route
 * took a *report* id (an `EvaluationReport`, one test case's result), not an
 * evaluation-run id, so it needs a lookup before it can be sent anywhere. See
 * `resolveReportRedirect` below / `ReportRedirect` in App.tsx.
 */
export interface LegacyRouteRedirect {
  /** react-router route pattern the legacy page was mounted on. */
  pattern: string;
  /** Destination template — `:param` tokens are filled from the match. */
  to: string;
}

export const legacyRouteRedirects: readonly LegacyRouteRedirect[] = [
  // Pre-evals3 pages
  { pattern: '/benchmarks', to: '/evaluations/benchmarks' },
  { pattern: '/benchmarks/:benchmarkId/runs', to: '/evaluations/benchmarks/:benchmarkId/runs' },
  { pattern: '/benchmarks/:benchmarkId/runs/:runId', to: '/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect' },
  { pattern: '/benchmarks/*', to: '/evaluations/benchmarks' },
  { pattern: '/test-cases', to: '/evaluations/test-cases' },
  { pattern: '/test-cases/:testCaseId/runs', to: '/evaluations/test-cases/:testCaseId' },
  { pattern: '/test-cases/*', to: '/evaluations/test-cases' },
  // Even older aliases that used to redirect to the pre-evals3 pages (one hop now)
  { pattern: '/evals', to: '/evaluations/test-cases' },
  { pattern: '/run', to: '/evaluations/test-cases' },
  { pattern: '/reports', to: '/evaluations/benchmarks' },
  { pattern: '/experiments', to: '/evaluations/benchmarks' },
  { pattern: '/experiments/:benchmarkId/runs', to: '/evaluations/benchmarks/:benchmarkId/runs' },
  // Older evals3 run-detail page → run inspector
  { pattern: '/evaluations/runs/:runId', to: '/evaluations/runs/:runId/inspect' },
];

/**
 * Fill a redirect template from route params. Params are URL-encoded so an
 * id containing `/` or `?` cannot escape its segment.
 */
export function fillRedirectTemplate(to: string, params: Record<string, string | undefined>): string {
  return to.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const value = params[name];
    return value === undefined ? '' : encodeURIComponent(value);
  });
}

/**
 * The evals3 route for an individual report (`EvaluationReport`) — the id the
 * legacy `/runs/:runId` route used to take. Reports that belong to a run open
 * in the run inspector (benchmark-scoped when the benchmark is known, so
 * classic embedded `benchmark.runs[]` ids resolve too) with `?reportId=` so
 * the inspector preselects that case; standalone single-case reports open on
 * the test case's detail page with `?run=` preselecting the run.
 */
export function resolveReportRedirect(report: {
  id: string;
  testCaseId: string;
  experimentId?: string;
  experimentRunId?: string;
}): string {
  const reportId = encodeURIComponent(report.id);
  if (report.experimentRunId) {
    const runId = encodeURIComponent(report.experimentRunId);
    if (report.experimentId) {
      return `/evaluations/benchmarks/${encodeURIComponent(report.experimentId)}/runs/${runId}/inspect?reportId=${reportId}`;
    }
    return `/evaluations/runs/${runId}/inspect?reportId=${reportId}`;
  }
  return `/evaluations/test-cases/${encodeURIComponent(report.testCaseId)}?run=${reportId}`;
}

/** Path to a single test-case run on the evals3 test-case detail page. */
export const testCaseRunPath = (testCaseId: string, reportId: string): string =>
  `/evaluations/test-cases/${encodeURIComponent(testCaseId)}?run=${encodeURIComponent(reportId)}`;
