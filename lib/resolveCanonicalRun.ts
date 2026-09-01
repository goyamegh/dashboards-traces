/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the CANONICAL run object for an id that may exist in two shapes:
 * a legacy `BenchmarkRun` projection embedded in `benchmark.runs[]` (never
 * carries `docType`, never kept in sync after the initial write) and a
 * first-class `EvaluationRun` doc (`docType: 'evaluation-run'`). Runs
 * created WITH a benchmarkId are dual-written as both (see
 * `server/routes/storage/evaluationRuns.ts`) -- the first-class doc is
 * always the freshest/most capable representation when it exists.
 *
 * Extracted out of RunInspectorPage.tsx (the first caller) so the
 * resolution logic is reusable and independently testable rather than a
 * page-local pattern other components/route handlers would have to
 * reinvent (see #462's Retry-judgement work, which needs the exact same
 * resolution to make its own EvaluationRun-only capability checks
 * meaningful on the benchmark-scoped route).
 *
 * `fetchEvaluationRun` is injected (rather than importing
 * `services/client` directly) so this stays a plain, synchronously
 * testable function with no module-mocking required.
 */

import type { BenchmarkRun, EvaluationRun } from '@/types/index.js';

export async function resolveCanonicalEvaluationRun(
  runId: string,
  embeddedProjection: BenchmarkRun,
  fetchEvaluationRun: (id: string) => Promise<EvaluationRun>,
): Promise<BenchmarkRun | EvaluationRun> {
  try {
    // Defensive `?? embeddedProjection`: some test doubles / API layers
    // resolve to a falsy value on "not found" instead of throwing.
    return (await fetchEvaluationRun(runId)) ?? embeddedProjection;
  } catch (err: any) {
    // A 404 means this run only ever exists as a legacy BenchmarkRun
    // (pre-#399, no first-class doc) -- expected, silent fallback. Any
    // OTHER failure (500, network error, auth) must NOT be silently
    // treated the same way: falling back is still the right availability
    // choice for a read-only inspector page (this page already degrades
    // gracefully elsewhere -- see loadData()'s report-summary fallback),
    // but masking a real failure identically to "doesn't exist" would
    // hide it from anyone debugging why results/stats look stale.
    if (err?.status !== 404) {
      console.warn(
        `[resolveCanonicalEvaluationRun] Failed to fetch first-class EvaluationRun doc for ${runId} (falling back to the embedded projection):`,
        err?.message ?? err,
      );
    }
    return embeddedProjection;
  }
}
