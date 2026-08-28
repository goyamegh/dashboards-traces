/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-only half of "re-run an evaluation run": the storage-aware check
 * that a source run's referenced benchmark(s)/version(s) still exist. Pure
 * naming/config-duplication logic lives in lib/evaluationRerun.ts (shared
 * with the UI's confirm-dialog preview); this file adds the one thing that
 * needs the storage module.
 */

import type { EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

export { computeRerunName, buildRerunConfig } from '@/lib/evaluationRerun';
export type { RerunConfig, BuildRerunConfigResult, BuildRerunConfigError } from '@/lib/evaluationRerun';

/**
 * Collect every (benchmarkId, benchmarkVersion) pair a source run references
 * — from `sources` entries of type `'benchmark'`, plus the run's own
 * top-level `benchmarkId`/`benchmarkVersion` association if not already
 * covered by a source entry with the same benchmarkId.
 */
function collectBenchmarkRefs(
  sourceRun: EvaluationRun
): Array<{ benchmarkId: string; benchmarkVersion?: number }> {
  const refs: Array<{ benchmarkId: string; benchmarkVersion?: number }> = [];
  for (const src of sourceRun.sources || []) {
    if (src.type === 'benchmark') {
      refs.push({ benchmarkId: src.benchmarkId, benchmarkVersion: src.benchmarkVersion });
    }
  }
  if (sourceRun.benchmarkId && !refs.some(r => r.benchmarkId === sourceRun.benchmarkId)) {
    refs.push({ benchmarkId: sourceRun.benchmarkId, benchmarkVersion: sourceRun.benchmarkVersion });
  }
  return refs;
}

/**
 * Verify every benchmark (and, if pinned, benchmark version) a source run
 * references still exists. Returns a clear, user-facing error message when
 * it doesn't (caller maps this to HTTP 409 — the run's config is no longer
 * satisfiable, not a client input error), or `null` when everything checks
 * out (including the common case: no benchmark source at all).
 *
 * Only fetches each distinct benchmarkId once even if referenced from
 * multiple places (a `sources` entry AND the top-level association, or
 * multiple `sources` entries pointing at the same benchmark).
 */
export async function checkBenchmarkSourcesStillExist(
  sourceRun: EvaluationRun,
  storage: Pick<IStorageModule, 'benchmarks'>
): Promise<string | null> {
  const refs = collectBenchmarkRefs(sourceRun);
  if (refs.length === 0) return null;

  const benchmarkCache = new Map<string, Awaited<ReturnType<IStorageModule['benchmarks']['getById']>>>();

  for (const { benchmarkId, benchmarkVersion } of refs) {
    if (!benchmarkCache.has(benchmarkId)) {
      benchmarkCache.set(benchmarkId, await storage.benchmarks.getById(benchmarkId));
    }
    const benchmark = benchmarkCache.get(benchmarkId);

    if (!benchmark) {
      return `Source benchmark "${benchmarkId}" no longer exists; cannot re-run.`;
    }

    if (benchmarkVersion != null && !(benchmark.versions || []).some(v => v.version === benchmarkVersion)) {
      return `Benchmark version ${benchmarkVersion} of "${benchmark.name}" no longer exists ` +
        `(current version: ${benchmark.currentVersion}); cannot re-run.`;
    }
  }

  return null;
}
