/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Evaluation-runs migration — extracts embedded `benchmark.runs[]` entries
 * into top-level EvaluationRun documents, preserving the run's original id
 * and stamping `benchmarkId`. Part of the "one run, one page" run-experience
 * convergence: the eval-run doc is the source of truth going forward;
 * `benchmark.runs[]` stays as a read-only legacy projection (no server
 * write-path changes in this iteration — see AGENTS.md).
 *
 * Split out of cli/commands/migrate.ts so the id-preservation +
 * idempotency logic is unit/integration-testable without invoking the CLI
 * process (ensureServer / commander wiring).
 */

import type { Benchmark, BenchmarkRun, EvaluationRun, TestCaseSnapshot, TestCaseSource } from '@/types/index.js';

/**
 * Build the EvaluationRun document for a legacy benchmark-embedded run.
 * Pure — no I/O. The id is PRESERVED from the embedded run so this is
 * idempotent to re-run (the caller skips ids that already exist as
 * eval-run docs; see {@link migrateEvaluationRuns}).
 */
export function buildEvaluationRunFromEmbedded(
  run: BenchmarkRun,
  benchmarkId: string
): Partial<EvaluationRun> {
  const runAny = run as any;
  return {
    id: run.id,
    name: run.name || `Run ${run.id.slice(0, 8)}`,
    createdAt: run.createdAt,
    completedAt: runAny.completedAt,
    status: run.status,
    agentKey: runAny.config?.agentKey || run.agentKey || 'unknown',
    modelId: runAny.config?.modelId || run.modelId || 'unknown',
    sources: [{ type: 'benchmark', benchmarkId }] as TestCaseSource[],
    trigger: 'api' as const,
    testCaseSnapshots: (run.testCaseSnapshots || []) as TestCaseSnapshot[],
    results: run.results || {},
    stats: run.stats,
    benchmarkId,
  };
}

export interface MigrateEvaluationRunsOptions {
  /** Default true — no writes are issued unless explicitly opted in. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface MigrateEvaluationRunsSummary {
  totalEmbeddedRuns: number;
  migrated: number;
  alreadyMigrated: number;
  errors: number;
  errorDetails: Array<{ runId: string; message: string }>;
  dryRun: boolean;
}

/**
 * Migrate every embedded run across `benchmarks` to a top-level
 * EvaluationRun document via `baseUrl`'s storage API.
 *
 * Idempotent: an embedded run whose id already resolves at
 * `GET /api/storage/evaluation-runs/:id` is counted as `alreadyMigrated`
 * and left untouched (no PUT is issued) — safe to run repeatedly, including
 * after a partial/interrupted previous run.
 *
 * `dryRun` (default true, per the caller's `options.dryRun ?? true`)
 * performs the same existence checks but issues no PUT — callers report
 * the same summary shape either way, distinguished by `summary.dryRun`.
 */
export async function migrateEvaluationRuns(
  baseUrl: string,
  benchmarks: Benchmark[],
  options: MigrateEvaluationRunsOptions = {}
): Promise<MigrateEvaluationRunsSummary> {
  const dryRun = options.dryRun ?? true;
  const log = options.onProgress ?? (() => {});

  const summary: MigrateEvaluationRunsSummary = {
    totalEmbeddedRuns: 0,
    migrated: 0,
    alreadyMigrated: 0,
    errors: 0,
    errorDetails: [],
    dryRun,
  };

  for (const benchmark of benchmarks) {
    const runs = benchmark.runs || [];
    summary.totalEmbeddedRuns += runs.length;

    for (const run of runs) {
      try {
        const checkRes = await fetch(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`);
        if (checkRes.ok) {
          summary.alreadyMigrated++;
          log(`  \u2713 ${run.id} already migrated`);
          continue;
        }
      } catch {
        // Fall through to create-path — a network hiccup on the existence
        // check must not silently skip a run that was never migrated.
      }

      const evalRun = buildEvaluationRunFromEmbedded(run, benchmark.id);

      if (dryRun) {
        summary.migrated++;
        log(`  [DRY RUN] would migrate ${run.id} (${evalRun.name}) \u2192 benchmarkId=${benchmark.id}`);
        continue;
      }

      try {
        const createRes = await fetch(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(evalRun),
        });
        if (!createRes.ok) {
          summary.errors++;
          summary.errorDetails.push({ runId: run.id, message: `HTTP ${createRes.status}` });
          continue;
        }
        summary.migrated++;
        log(`  \u2713 migrated ${run.id}`);
      } catch (err) {
        summary.errors++;
        const message = err instanceof Error ? err.message : 'Unknown error';
        summary.errorDetails.push({ runId: run.id, message });
      }
    }
  }

  return summary;
}
