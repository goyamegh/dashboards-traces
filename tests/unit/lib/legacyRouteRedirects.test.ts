/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  legacyRouteRedirects,
  fillRedirectTemplate,
  resolveReportRedirect,
  testCaseRunPath,
} from '@/lib/legacyRouteRedirects';

describe('legacyRouteRedirects (pure table)', () => {
  it('maps every retired pre-evals3 route and the older evals3 run-detail page to an evals3 twin', () => {
    const byPattern = Object.fromEntries(legacyRouteRedirects.map(r => [r.pattern, r.to]));
    expect(byPattern).toEqual({
      '/benchmarks': '/evaluations/benchmarks',
      '/benchmarks/:benchmarkId/runs': '/evaluations/benchmarks/:benchmarkId/runs',
      '/benchmarks/:benchmarkId/runs/:runId': '/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect',
      '/benchmarks/*': '/evaluations/benchmarks',
      '/test-cases': '/evaluations/test-cases',
      '/test-cases/:testCaseId/runs': '/evaluations/test-cases/:testCaseId',
      '/test-cases/*': '/evaluations/test-cases',
      '/evals': '/evaluations/test-cases',
      '/run': '/evaluations/test-cases',
      '/reports': '/evaluations/benchmarks',
      '/experiments': '/evaluations/benchmarks',
      '/experiments/:benchmarkId/runs': '/evaluations/benchmarks/:benchmarkId/runs',
      '/evaluations/runs/:runId': '/evaluations/runs/:runId/inspect',
    });
  });

  it('every destination is an evals3 route (never another legacy route — no redirect chains)', () => {
    const legacyPrefixes = ['/benchmarks', '/test-cases', '/runs/', '/evals', '/run', '/reports', '/experiments'];
    for (const { to } of legacyRouteRedirects) {
      expect(to.startsWith('/evaluations/')).toBe(true);
      for (const prefix of legacyPrefixes) expect(to.startsWith(prefix)).toBe(false);
    }
  });

  it('every :param used in a destination exists in its pattern', () => {
    for (const { pattern, to } of legacyRouteRedirects) {
      const patternParams = new Set((pattern.match(/:([A-Za-z0-9_]+)/g) || []).map(p => p.slice(1)));
      for (const m of to.match(/:([A-Za-z0-9_]+)/g) || []) {
        expect(patternParams.has(m.slice(1))).toBe(true);
      }
    }
  });
});

describe('fillRedirectTemplate', () => {
  it('substitutes params and URL-encodes them', () => {
    expect(fillRedirectTemplate('/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect', { benchmarkId: 'b 1', runId: 'r/2' }))
      .toBe('/evaluations/benchmarks/b%201/runs/r%2F2/inspect');
  });

  it('drops a missing param rather than emitting the token', () => {
    expect(fillRedirectTemplate('/evaluations/test-cases/:testCaseId', {})).toBe('/evaluations/test-cases/');
  });
});

describe('resolveReportRedirect', () => {
  it('sends a report of a benchmark run to the benchmark-scoped inspector with ?reportId', () => {
    expect(resolveReportRedirect({ id: 'rep1', testCaseId: 'tc1', experimentId: 'bm1', experimentRunId: 'run1' }))
      .toBe('/evaluations/benchmarks/bm1/runs/run1/inspect?reportId=rep1');
  });

  it('sends a report of an ad-hoc evaluation run to the bare inspector with ?reportId', () => {
    expect(resolveReportRedirect({ id: 'rep1', testCaseId: 'tc1', experimentRunId: 'run1' }))
      .toBe('/evaluations/runs/run1/inspect?reportId=rep1');
  });

  it('sends a standalone single-case report to the test case detail page with ?run', () => {
    expect(resolveReportRedirect({ id: 'rep1', testCaseId: 'tc1' }))
      .toBe('/evaluations/test-cases/tc1?run=rep1');
  });

  it('encodes ids', () => {
    expect(resolveReportRedirect({ id: 'r?1', testCaseId: 't/c' })).toBe('/evaluations/test-cases/t%2Fc?run=r%3F1');
    expect(testCaseRunPath('t/c', 'r?1')).toBe('/evaluations/test-cases/t%2Fc?run=r%3F1');
  });
});
