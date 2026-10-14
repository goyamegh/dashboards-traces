/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pair selection for the trace-grounded deep-dive ("What's actually
 * different") on a compare page with THREE OR MORE selected runs.
 *
 * The deep-dive is pairwise by design (`POST /api/comparison/deep-dive` takes
 * exactly two report ids) and that contract is deliberately kept — this
 * module only decides WHICH two of the selected runs it compares:
 *
 *  - default: A = the OLDEST selected run (the baseline), B = the NEWEST
 *  - a `deepDive=<idA>,<idB>` URL param overrides the default so a shared
 *    link reproduces the pair; an invalid/partial/absent param → default
 *  - A ≠ B is always enforced
 *
 * Pure functions, unit tested directly.
 */

import { BenchmarkRun } from '@/types';

/** URL search param that pins the deep-dive pair (`deepDive=<idA>,<idB>`). */
export const DEEP_DIVE_PAIR_PARAM = 'deepDive';

export type DeepDivePair = [string, string];

const createdMs = (run: BenchmarkRun): number => {
  const t = Date.parse(run.createdAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Default pair for a set of selected runs: oldest (baseline) → A, newest → B.
 * Ties (identical/unparseable `createdAt`) fall back to selection order, so
 * the result is deterministic for a given selection. `null` when fewer than
 * two runs are selected.
 */
export function defaultDeepDivePair(runs: BenchmarkRun[]): DeepDivePair | null {
  if (runs.length < 2) return null;
  // Stable sort: equal timestamps keep their selection order.
  const sorted = runs
    .map((run, index) => ({ run, index }))
    .sort((x, y) => createdMs(x.run) - createdMs(y.run) || x.index - y.index)
    .map((x) => x.run);
  return [sorted[0].id, sorted[sorted.length - 1].id];
}

/**
 * Parse `deepDive=<idA>,<idB>`. Valid only when both ids are distinct and both
 * name a currently selected run; anything else returns `null` (caller falls
 * back to {@link defaultDeepDivePair}).
 */
export function parseDeepDivePairParam(param: string | null | undefined, selectedRunIds: string[]): DeepDivePair | null {
  if (!param) return null;
  const parts = param.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === b) return null;
  if (!selectedRunIds.includes(a) || !selectedRunIds.includes(b)) return null;
  return [a, b];
}

/** Serialize a pair for the URL (`<idA>,<idB>`). */
export function serializeDeepDivePair(pair: DeepDivePair): string {
  return `${pair[0]},${pair[1]}`;
}

/**
 * Resolve the pair the panel should compare: the URL's pair when it is valid
 * for the current selection, else the default. Also reports whether the
 * resolved pair IS the default — the default pair auto-starts the (expensive)
 * LLM job exactly like the 2-run page does; any other pair waits for an
 * explicit click so switching runs never launches surprise LLM work.
 */
export function resolveDeepDivePair(
  runs: BenchmarkRun[],
  param: string | null | undefined
): { pair: DeepDivePair; isDefault: boolean } | null {
  const fallback = defaultDeepDivePair(runs);
  if (!fallback) return null;
  const fromUrl = parseDeepDivePairParam(param, runs.map((r) => r.id));
  if (!fromUrl) return { pair: fallback, isDefault: true };
  const isDefault = fromUrl[0] === fallback[0] && fromUrl[1] === fallback[1];
  return { pair: fromUrl, isDefault };
}

/**
 * Change ONE side of the pair while keeping A ≠ B: if the new value collides
 * with the other side, the other side takes the value this side used to hold
 * (a swap), which is the least surprising way to keep both selects valid.
 */
export function changeDeepDivePairSide(pair: DeepDivePair, side: 'A' | 'B', runId: string): DeepDivePair {
  const [a, b] = pair;
  if (side === 'A') return runId === b ? [runId, a] : [runId, b];
  return runId === a ? [b, runId] : [a, runId];
}

/**
 * Keep a URL pair only while both of its runs stay selected; otherwise drop
 * it (the page falls back to the default pair for the new selection).
 */
export function retainDeepDivePairForSelection(param: string | null | undefined, selectedRunIds: string[]): string | undefined {
  const pair = parseDeepDivePairParam(param, selectedRunIds);
  return pair ? serializeDeepDivePair(pair) : undefined;
}
