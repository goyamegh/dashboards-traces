/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orphan EvaluationRun recovery on server boot.
 *
 * Sister of `benchmarkRunRecoveryOnBoot.ts`. Where that module fixes orphan
 * *legacy* BenchmarkRun execution state (`/api/storage/benchmarks/:id/execute`),
 * this one fixes the same failure mode for the unified, top-level
 * EvaluationRun model (`/api/storage/evaluation-runs`):
 *
 *   - A run is mid-flight (`EvaluationRun.status === 'running'`)
 *   - The server is killed (deploy / OOM / SIGKILL / uncaught rejection that
 *     bypasses the create route's own catch block)
 *   - On restart, the top-level run doc is still `'running'` forever — the
 *     in-memory `activeCancellationTokens` registry
 *     (`server/routes/storage/evaluationRuns.ts`) was lost with the dead
 *     process, and nothing else ever revisits this run id.
 *
 * Why this is its own module and not folded into `benchmarkRunRecoveryOnBoot`:
 * that module only scans `benchmark.runs[]` (the embedded projection) — it
 * now ALSO recovers evaluation-run-based projections there (since the create
 * route links a `running` projection into `benchmark.runs` immediately, see
 * `buildStartingBenchmarkRunProjection`), but it has no way to reach the
 * TOP-LEVEL `EvaluationRun` doc, and ad-hoc runs (no `benchmarkId`) have no
 * embedded projection at all. Without this module, a crashed evaluation-run
 * would either stay `running` forever on the Evaluations page (ad-hoc runs),
 * or worse, end up INCONSISTENT with its own benchmark projection (the
 * legacy recovery marks the embedded copy `'failed'`, while the top-level
 * doc that the Evaluations page reads stays `'running'` forever) — a new bug
 * this fix would otherwise introduce.
 *
 * On boot, scan top-level evaluation-run docs for runs that are:
 *   - `status === 'running'` AND
 *   - older than `EVALUATION_RUN_STALE_AFTER_MS` (default 1h) AND
 *   - not in the *current* process's `activeCancellationTokens` map (so we
 *     don't kill an in-flight run started by a concurrent boot path)
 *
 * For each such run:
 *   - Mark every result whose `status` is still `'running'`/`'pending'` and
 *     which has **no** `reportId` as `'failed'` with a recovery note.
 *   - Mark the run itself as `'failed'`.
 *   - If it has a `benchmarkId`, sync the embedded `benchmark.runs`
 *     projection to the same terminal state (add-if-missing, update
 *     otherwise) so the two views can never disagree.
 *
 * Behaviour can be disabled in tests with `EVALUATION_RUN_RECOVERY_DISABLED=1`.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';
import { isEvaluationRunActiveInThisProcess, buildTerminalBenchmarkRunProjection, linkTerminalBenchmarkRunProjection } from '../routes/storage/evaluationRuns.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface EvaluationRunRecoveryStat {
  scannedRuns: number;
  staleRuns: number;
  resultsMarkedFailed: number;
  runsMarkedFailed: number;
  benchmarkProjectionsSynced: number;
  errors: number;
  durationMs: number;
}

/**
 * Scan storage for stale `running` EvaluationRuns and fail them out.
 * Idempotent and safe to run on every boot.
 */
export async function recoverOrphanEvaluationRuns(storage: IStorageModule): Promise<EvaluationRunRecoveryStat> {
  const startedAt = Date.now();
  const stat: EvaluationRunRecoveryStat = {
    scannedRuns: 0,
    staleRuns: 0,
    resultsMarkedFailed: 0,
    runsMarkedFailed: 0,
    benchmarkProjectionsSynced: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env.EVALUATION_RUN_RECOVERY_DISABLED === '1') {
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }

  const staleAfterMs = envInt('EVALUATION_RUN_STALE_AFTER_MS', 60 * 60 * 1000); // 1h
  const pageSize = envInt('EVALUATION_RUN_RECOVERY_PAGE_SIZE', 100);
  const maxPages = envInt('EVALUATION_RUN_RECOVERY_MAX_PAGES', 50);
  const now = Date.now();

  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    let runs: EvaluationRun[];
    try {
      const result = await storage.evaluationRuns.list({ status: 'running', from, size: pageSize });
      runs = result.items;
    } catch (err: any) {
      stat.errors++;
      console.warn(`[evaluationRunRecovery] evaluationRuns.list failed at from=${from}: ${err?.message || err}`);
      break;
    }
    if (!runs || runs.length === 0) break;
    stat.scannedRuns += runs.length;

    for (const run of runs) {
      const runStart = new Date(run.createdAt || 0).getTime();
      const ageMs = Number.isFinite(runStart) && runStart > 0 ? now - runStart : Infinity;
      if (ageMs < staleAfterMs) continue;

      if (isEvaluationRunActiveInThisProcess(run.id)) {
        // Legitimately still running in this process — leave alone.
        continue;
      }

      stat.staleRuns++;
      const reason = 'Evaluation run did not complete this test case ' +
        "(stale 'running' run recovered during boot recovery; original process likely died)";

      const newResults: Record<string, any> = {};
      for (const [tcId, res] of Object.entries(run.results || {})) {
        const r: any = res;
        const isUnstarted = (r?.status === 'pending' || r?.status === 'running') && !r?.reportId;
        if (isUnstarted) {
          newResults[tcId] = { reportId: '', status: 'failed', error: reason };
          stat.resultsMarkedFailed++;
        } else {
          newResults[tcId] = r;
        }
      }

      const completedAt = new Date().toISOString();
      let recoveredRun: EvaluationRun;
      try {
        recoveredRun = await storage.evaluationRuns.update(run.id, {
          status: 'failed',
          completedAt,
          results: newResults,
          error: reason,
        });
        stat.runsMarkedFailed++;
      } catch (err: any) {
        stat.errors++;
        console.warn(`[evaluationRunRecovery] Failed to update run ${run.id}: ${err?.message || err}`);
        continue;
      }

      if (recoveredRun.benchmarkId) {
        try {
          const projection = buildTerminalBenchmarkRunProjection(recoveredRun, completedAt);
          await linkTerminalBenchmarkRunProjection(storage, recoveredRun.benchmarkId, projection);
          stat.benchmarkProjectionsSynced++;
        } catch (err: any) {
          stat.errors++;
          console.warn(
            `[evaluationRunRecovery] Failed to sync benchmark ${recoveredRun.benchmarkId} projection for run ${run.id}: ${err?.message || err}`
          );
        }
      }

      console.log(`[evaluationRunRecovery] Marked stale run ${run.id} as failed (created ${run.createdAt})`);
    }

    if (runs.length < pageSize) break;
    from += pageSize;
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Wrapper that logs a single summary line and never throws.
 * Suitable for fire-and-forget invocation from `startServer()`.
 */
export async function recoverOrphanEvaluationRunsSafely(storage: IStorageModule): Promise<void> {
  try {
    const stat = await recoverOrphanEvaluationRuns(storage);
    if (stat.staleRuns === 0 && stat.errors === 0) {
      console.log(
        `[evaluationRunRecovery] runs=${stat.scannedRuns} no orphan running runs [${stat.durationMs}ms]`
      );
    } else {
      console.log(
        `[evaluationRunRecovery] runs=${stat.scannedRuns} staleRuns=${stat.staleRuns} ` +
        `runsMarkedFailed=${stat.runsMarkedFailed} resultsMarkedFailed=${stat.resultsMarkedFailed} ` +
        `benchmarkProjectionsSynced=${stat.benchmarkProjectionsSynced} errors=${stat.errors} [${stat.durationMs}ms]`
      );
    }
  } catch (err: any) {
    console.warn(`[evaluationRunRecovery] Unhandled failure: ${err?.message || err}`);
  }
}
