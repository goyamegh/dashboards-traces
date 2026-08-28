/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark Leaderboard Aggregation
 *
 * Powers the "By benchmark" view of the dashboard's "Agents Needing
 * Improvement" widget: for a chosen benchmark, rank every agent that has a
 * completed run on it by pass rate (latest completed run per agent, not
 * best-of — see `computeBenchmarkLeaderboard`).
 *
 * Kept as a standalone, dependency-light module (no React) so the
 * aggregation + ranking + N/M formatting are unit-testable without
 * rendering, and so it doesn't collide with `lib/dashboardMetrics.ts`
 * (owned by the separate, in-flight Performance Trends work).
 */

import { Benchmark, BenchmarkRun } from '@/types';
import { bucketRunResults } from '@/lib/runStats';

/**
 * A single ranked row: one agent's latest completed run on a benchmark.
 */
export interface BenchmarkLeaderboardRow {
  agentKey: string;
  /** The latest completed run for this agent on this benchmark (not best-of). */
  run: BenchmarkRun;
  /** Test cases with a 'passed' verdict. */
  passed: number;
  /** Test cases with a 'failed' verdict. */
  failed: number;
  /** Test cases the evaluator could not produce a verdict for (excluded from passRate). */
  errored: number;
  /** Total test cases in the run (passed + failed + errored + pending). */
  total: number;
  /**
   * `total - errored` — the denominator for the "N/M" display and passRate,
   * matching lib/runStats.ts's canonical convention (excludes evaluator
   * errors so a misconfigured judge can't masquerade as an agent failure).
   * Equal to passed + failed for a well-formed completed run (pending === 0).
   */
  evaluable: number;
  /** 0-100, one-decimal precision expected at render time. 0 when evaluable === 0. */
  passRate: number;
}

/** A benchmark eligible for the leaderboard selector, with its most recent completed-run time. */
export interface BenchmarkLeaderboardOption {
  id: string;
  name: string;
  lastCompletedRunAt: string;
}

/**
 * A run is "completed" for leaderboard purposes if:
 * - `status` is explicitly set: true only for 'completed'.
 * - `status` is undefined (legacy data, predating the status field): treat
 *   as completed only when every test case has resolved (none still
 *   'pending'/'running') — conservative, since a half-finished run
 *   shouldn't rank an agent on a leaderboard.
 */
export function isRunCompleted(run: BenchmarkRun): boolean {
  if (run.status) return run.status === 'completed';
  const results = Object.values(run.results || {});
  if (results.length === 0) return false;
  return results.every(r => r.status !== 'pending' && r.status !== 'running');
}

/**
 * Bucket a run's pass/fail/errored/total using the same canonical source of
 * truth as the Evaluation Runs list and the Comparison page
 * (`lib/runStats.bucketRunResults`, recomputed from the persisted per-case
 * verdicts in `run.results` — see PR #417). Falls back to the denormalized
 * `run.stats` only when `results` isn't populated.
 */
function bucketRun(run: BenchmarkRun): { passed: number; failed: number; errored: number; total: number } {
  if (run.results && Object.keys(run.results).length > 0) {
    const b = bucketRunResults(run.results as Record<string, { status?: string; passFailStatus?: string }>);
    return { passed: b.passed, failed: b.failed, errored: b.errored, total: b.total };
  }
  if (run.stats && run.stats.total > 0) {
    return {
      passed: run.stats.passed,
      failed: run.stats.failed,
      errored: run.stats.errored ?? 0,
      total: run.stats.total,
    };
  }
  return { passed: 0, failed: 0, errored: 0, total: 0 };
}

function toLeaderboardRow(agentKey: string, run: BenchmarkRun): BenchmarkLeaderboardRow {
  const { passed, failed, errored, total } = bucketRun(run);
  const evaluable = Math.max(0, total - errored);
  const passRate = evaluable > 0 ? (passed / evaluable) * 100 : 0;
  return { agentKey, run, passed, failed, errored, total, evaluable, passRate };
}

/**
 * Rank agents on a benchmark by pass rate (desc) using each agent's LATEST
 * completed run on that benchmark — not their best run. Rationale: a
 * leaderboard answers "how is each agent doing right now", and best-of would
 * let a lucky early run mask a real regression. The per-run tooltip callout
 * (run name + timestamp) makes the "latest, not best" choice visible in the UI.
 *
 * Ties broken by more evaluable test cases (a 10/10 agent ranks above an
 * 8/8 agent at the same 100% rate — more evidence), then agent key for a
 * fully deterministic order.
 */
export function computeBenchmarkLeaderboard(benchmark: Benchmark): BenchmarkLeaderboardRow[] {
  const latestByAgent = new Map<string, BenchmarkRun>();
  for (const run of benchmark.runs || []) {
    if (!isRunCompleted(run)) continue;
    const agentKey = run.agentKey || 'unknown';
    const existing = latestByAgent.get(agentKey);
    if (!existing || new Date(run.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestByAgent.set(agentKey, run);
    }
  }
  const rows = Array.from(latestByAgent.entries()).map(([agentKey, run]) => toLeaderboardRow(agentKey, run));
  return rows.sort((a, b) =>
    b.passRate - a.passRate ||
    b.evaluable - a.evaluable ||
    a.agentKey.localeCompare(b.agentKey)
  );
}

/**
 * Benchmarks that have at least one completed run, ordered by most-recent
 * completed run (desc) — i.e. the benchmark selector's intended order, with
 * index 0 being the default preselection.
 */
export function getBenchmarksWithCompletedRuns(benchmarks: Benchmark[]): BenchmarkLeaderboardOption[] {
  const options: BenchmarkLeaderboardOption[] = [];
  for (const bm of benchmarks) {
    const completedRuns = (bm.runs || []).filter(isRunCompleted);
    if (completedRuns.length === 0) continue;
    const lastCompletedRunAt = completedRuns.reduce(
      (latest, run) => (new Date(run.createdAt).getTime() > new Date(latest).getTime() ? run.createdAt : latest),
      completedRuns[0].createdAt
    );
    options.push({ id: bm.id, name: bm.name, lastCompletedRunAt });
  }
  return options.sort((a, b) => new Date(b.lastCompletedRunAt).getTime() - new Date(a.lastCompletedRunAt).getTime());
}

/** "N/M" — passed over evaluable (passed + failed; errored test cases excluded). */
export function formatPassRateFraction(row: Pick<BenchmarkLeaderboardRow, 'passed' | 'evaluable'>): string {
  return `${row.passed}/${row.evaluable}`;
}

/** "NN.N%" — one decimal place, matching the spec's requested precision. */
export function formatPassRatePercent(passRate: number): string {
  return `${passRate.toFixed(1)}%`;
}
