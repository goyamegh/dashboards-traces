/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, isomorphic helpers for "re-run an evaluation run" (duplicate the
 * source run's config into a brand-new run, linked back via `rerunOf`).
 *
 * Split out from the route/service layer so both the server (which owns the
 * real duplication + creation) and the UI (which renders a name preview in
 * the confirm dialog before the user commits) can share the exact same
 * naming logic without an extra network round-trip. No storage/IO here.
 */

import type { EvaluationRun, TestCaseSource } from '@/types';

const DEFAULT_RUN_NAME = 'Evaluation Run';

/**
 * Matches a trailing "(re-run)" or "(re-run N)" suffix, case-insensitively,
 * capturing the base name and the optional numeric suffix.
 */
const RERUN_SUFFIX_RE = /^(.*?)\s*\(re-run(?:\s+(\d+))?\)$/i;

/**
 * Compute the name for a new run being created as a re-run of `sourceName`.
 *
 * - "My Run"            -> "My Run (re-run)"
 * - "My Run (re-run)"   -> "My Run (re-run 2)"
 * - "My Run (re-run 2)" -> "My Run (re-run 3)"
 * - undefined/empty     -> "Evaluation Run (re-run)"
 */
export function computeRerunName(sourceName: string | undefined | null): string {
  const trimmed = (sourceName || '').trim();
  const base = trimmed || DEFAULT_RUN_NAME;

  const match = base.match(RERUN_SUFFIX_RE);
  if (!match) {
    return `${base} (re-run)`;
  }

  const [, rawBaseName, suffixNumber] = match;
  // A source named literally "(re-run)" / "(re-run 2)" (no prefix) captures
  // an empty baseName — fall back to the default rather than emitting a
  // leading-space name like " (re-run 2)".
  const baseName = rawBaseName.trim() || DEFAULT_RUN_NAME;
  const nextNumber = suffixNumber ? parseInt(suffixNumber, 10) + 1 : 2;
  return `${baseName} (re-run ${nextNumber})`;
}

/**
 * Fields duplicated onto the new run when re-running a source run. Mirrors
 * the subset of {@link EvaluationRun} that `POST /api/storage/evaluation-runs`
 * accepts as input (see server/routes/storage/evaluationRuns.ts) — i.e. the
 * "config" as opposed to results/stats/timestamps, which are always fresh.
 */
export interface RerunConfig {
  sources: TestCaseSource[];
  agentKey: string;
  /** Fallback modelId if the agent's own config can't resolve one (legacy). */
  modelId: string;
  judgeModelId?: string;
  evaluatorId?: string;
  headers?: Record<string, string>;
  concurrency?: number;
  agentEndpoint?: string;
  description?: string;
  benchmarkId?: string;
  benchmarkVersion?: number;
}

export interface BuildRerunConfigResult {
  config: RerunConfig;
  /**
   * Human-readable notes on which fields were missing on the source run and
   * what explicit default was substituted (empty when the source run's
   * config was fully populated). Surfaced back to the caller (API response
   * -> UI) so a legacy run's best-effort re-run isn't a silent guess.
   */
  defaultsApplied: string[];
}

export interface BuildRerunConfigError {
  error: string;
}

/**
 * Duplicate a source run's execution config for a re-run, applying explicit,
 * reported defaults for fields missing on legacy run documents. Pure
 * function — no storage access (benchmark-existence checks live in
 * services/evaluationRerun.ts, which needs the storage module).
 *
 * Returns `{ error }` only when the source run is missing a field with no
 * safe default (nothing to run, or no agent to run it against).
 */
export function buildRerunConfig(
  sourceRun: EvaluationRun
): BuildRerunConfigResult | BuildRerunConfigError {
  const defaultsApplied: string[] = [];

  if (!sourceRun.agentKey) {
    return { error: 'Source run is missing agentKey; cannot determine which agent to re-run.' };
  }

  let sources = sourceRun.sources;
  if (!sources || sources.length === 0) {
    const snapshotIds = (sourceRun.testCaseSnapshots || []).map(s => s.id);
    if (snapshotIds.length === 0) {
      return {
        error: 'Source run has no test cases to re-run (missing both sources and testCaseSnapshots).',
      };
    }
    sources = [{ type: 'test-case-ids', ids: snapshotIds }];
    defaultsApplied.push(
      `sources -> derived from testCaseSnapshots (${snapshotIds.length} test case id(s); legacy run had no sources recorded)`
    );
  }

  let concurrency = sourceRun.concurrency;
  if (concurrency == null) {
    concurrency = 1;
    defaultsApplied.push('concurrency -> 1 (default; not set on source run)');
  }

  const config: RerunConfig = {
    sources,
    agentKey: sourceRun.agentKey,
    modelId: sourceRun.modelId || '',
    judgeModelId: sourceRun.judgeModelId,
    evaluatorId: sourceRun.evaluatorId,
    headers: sourceRun.headers,
    concurrency,
    agentEndpoint: sourceRun.agentEndpoint,
    description: sourceRun.description,
    benchmarkId: sourceRun.benchmarkId,
    benchmarkVersion: sourceRun.benchmarkVersion,
  };

  // NOTE: evaluatorId/judgeModelId/agentEndpoint/headers/description are
  // legitimately optional on ANY run (not just legacy ones), so leaving them
  // `undefined` is normal behavior, not a legacy-config gap — they are NOT
  // reported in `defaultsApplied` (that list is reserved for cases where we
  // had to fabricate a value because the source run's config was
  // incomplete).

  return { config, defaultsApplied };
}
