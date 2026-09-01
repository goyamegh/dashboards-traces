/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runDetailUrl } from '@/lib/runLinks';

describe('runDetailUrl', () => {
  it('returns the canonical top-level URL for a run with no benchmarkId (ad-hoc)', () => {
    expect(runDetailUrl({ id: 'eval-run-1' })).toBe('/evaluations/runs/eval-run-1');
  });

  it('returns the canonical top-level URL for a benchmark-linked eval-run doc (default)', () => {
    // The default/common case: an EvaluationRun doc always resolves via the
    // top-level route regardless of benchmarkId — RunInspectorPage looks up
    // the benchmark itself.
    expect(runDetailUrl({ id: 'eval-run-1', benchmarkId: 'bench-1' })).toBe('/evaluations/runs/eval-run-1');
  });

  it('is unaffected by "inspect intent" — there is no /inspect suffix on the canonical URL', () => {
    const url = runDetailUrl({ id: 'eval-run-1', benchmarkId: 'bench-1' });
    expect(url).not.toContain('/inspect');
  });

  it('returns the benchmark-nested short URL for a legacy benchmark-embedded-only run (relies on the existing redirect to /inspect)', () => {
    expect(
      runDetailUrl({ id: 'run-legacy-1', benchmarkId: 'bench-1' }, { legacyBenchmarkEmbedded: true })
    ).toBe('/evaluations/benchmarks/bench-1/runs/run-legacy-1');
  });

  it('falls back to the top-level URL for a legacy row that somehow has no benchmarkId', () => {
    // legacyBenchmarkEmbedded implies a benchmark.runs[] projection, which by
    // definition always has a parent benchmark id — but guard the case
    // defensively rather than emit a URL with an empty segment.
    expect(
      runDetailUrl({ id: 'run-legacy-1' }, { legacyBenchmarkEmbedded: true })
    ).toBe('/evaluations/runs/run-legacy-1');
  });

  it('treats a null benchmarkId the same as undefined', () => {
    expect(runDetailUrl({ id: 'eval-run-1', benchmarkId: null })).toBe('/evaluations/runs/eval-run-1');
    expect(
      runDetailUrl({ id: 'run-legacy-1', benchmarkId: null }, { legacyBenchmarkEmbedded: true })
    ).toBe('/evaluations/runs/run-legacy-1');
  });
});
