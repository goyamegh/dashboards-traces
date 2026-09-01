/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EvaluationRun } from '@/types';

/**
 * Client-side heuristic mirroring the server's liveness check: a 'running'
 * run whose last liveness signal (heartbeat > resumed > created) is older
 * than 10 minutes probably lost its server. The server re-validates against
 * the authoritative EVALUATION_RUN_STALE_AFTER_MS on resume, so a false
 * positive here just gets a clear 409.
 *
 * Shared by EvalRunDetailPage (which keeps its own inline copy — it's the
 * frozen revert backup for the run-experience convergence, so it is not
 * repointed at this module) and RunInspectorPage.
 */
export function runLooksOrphaned(run: EvaluationRun): boolean {
  const last = new Date(run.heartbeatAt || run.resumedAt || run.createdAt || 0).getTime();
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last > 10 * 60 * 1000;
}
