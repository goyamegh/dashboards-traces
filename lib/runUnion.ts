/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * unionRunsByPrecedence — pure merge for the "one run, one page" read
 * convergence (Phase 2).
 *
 * Today one logical run can exist as up to two records: a legacy
 * benchmark-embedded projection (`benchmark.runs[]`, historically
 * terminal-only) and a top-level EvaluationRun document (the source of
 * truth going forward). Both EvalRunsPage and BenchmarkRunsPage need to
 * union the two collections by id and, when a run exists in both, prefer
 * the EvaluationRun doc's data. Extracted here as a pure function so the
 * precedence rule is unit-testable without mounting either page.
 */

export type RunUnionSource = 'eval-run' | 'benchmark-run';

export interface RunUnionRow<TBenchRun, TEvalRun> {
  id: string;
  /** Which record supplies this row's data. 'eval-run' wins when both exist. */
  source: RunUnionSource;
  benchmarkRun?: TBenchRun;
  evalRun?: TEvalRun;
}

/**
 * Merge benchmark-embedded runs with top-level evaluation-run docs.
 *
 * - A run present in both collections (same id) is ONE row, sourced from
 *   the eval-run doc (`source: 'eval-run'`) — it is the authoritative
 *   record; the embedded projection is kept alongside for callers that
 *   need benchmark-specific fields (e.g. `benchmarkVersion`).
 * - A run present only in `benchmarkRuns` keeps `source: 'benchmark-run'`
 *   (legacy-only; no top-level doc exists for it yet).
 * - A run present only in `evalRuns` is `source: 'eval-run'` with no
 *   `benchmarkRun` — this is the "in-flight / unlinked eval-run becomes
 *   visible" case the benchmark-details union read exists for.
 *
 * Order is NOT guaranteed — callers that need a specific order (e.g.
 * newest-first) should sort the result themselves.
 */
export function unionRunsByPrecedence<TBenchRun extends { id: string }, TEvalRun extends { id: string }>(
  benchmarkRuns: TBenchRun[] | undefined | null,
  evalRuns: TEvalRun[] | undefined | null
): Array<RunUnionRow<TBenchRun, TEvalRun>> {
  const byId = new Map<string, RunUnionRow<TBenchRun, TEvalRun>>();

  for (const br of benchmarkRuns || []) {
    byId.set(br.id, { id: br.id, source: 'benchmark-run', benchmarkRun: br });
  }

  for (const er of evalRuns || []) {
    const existing = byId.get(er.id);
    byId.set(er.id, {
      id: er.id,
      source: 'eval-run',
      evalRun: er,
      benchmarkRun: existing?.benchmarkRun,
    });
  }

  return Array.from(byId.values());
}
