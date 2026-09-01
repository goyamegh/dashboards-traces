/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * runDetailUrl — single canonical URL builder for "run detail" links.
 *
 * Part of the "one run, one page" convergence: RunInspectorPage is now the
 * canonical detail surface at /evaluations/runs/:runId (Phase 1). It
 * resolves benchmark context (name, breadcrumbs) from the run doc's
 * `benchmarkId` itself, so a top-level EvaluationRun doc's URL never needs
 * to carry the benchmark id.
 *
 * The one case that still needs a benchmark-scoped URL is a LEGACY run that
 * exists only as a `benchmark.runs[]` projection with no corresponding
 * top-level EvaluationRun document — there is nothing to resolve at
 * `/evaluations/runs/:id` for it (yet — `agent-health migrate
 * evaluation-runs` backfills these). Pass `legacyBenchmarkEmbedded: true`
 * for that case only.
 */

export interface RunLinkTarget {
  id: string;
  benchmarkId?: string | null;
}

export interface RunDetailUrlOptions {
  /**
   * True when this row's ONLY backing record is a benchmark.runs[]
   * projection (no top-level eval-run doc exists for it). Defaults to
   * false — the common/default case is a top-level EvaluationRun doc,
   * which always resolves via the canonical top-level route regardless of
   * whether it happens to carry a benchmarkId.
   */
  legacyBenchmarkEmbedded?: boolean;
}

/** Canonical detail URL for a run — see module doc above. */
export function runDetailUrl(run: RunLinkTarget, options: RunDetailUrlOptions = {}): string {
  if (options.legacyBenchmarkEmbedded && run.benchmarkId) {
    // Deliberately the SHORT nested URL (no /inspect suffix): the existing
    // `/evaluations/benchmarks/:benchmarkId/runs/:runId` → Navigate("inspect")
    // route (App.tsx, untouched by this convergence) already completes the
    // trip to the inspector. Keeping this helper's output short matches that
    // pre-existing redirect contract exactly (see comparison-open-run-deep-
    // link.spec.ts, which pins the literal href).
    return `/evaluations/benchmarks/${run.benchmarkId}/runs/${run.id}`;
  }
  return `/evaluations/runs/${run.id}`;
}
