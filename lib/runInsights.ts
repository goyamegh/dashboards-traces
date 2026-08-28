/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic (no-LLM) aggregation helpers for the run-report "insights"
 * pane (RunInsightsPane.tsx), shown on the bare
 * `/benchmarks/:benchmarkId/runs/:runId` route when no test case is
 * selected — see owner feedback on goyamegh/run-report-redesign: "if no
 * test case is selected, the right side can show an aggregated view ...
 * why did the failing tests fail — something that is complete info."
 *
 * Everything here is a pure function over already-fetched data (report
 * summaries + test-case categories). No network calls, no LLM calls — v1
 * is explicitly deterministic-only per the product ask.
 */

// ── Category pass/fail bars ────────────────────────────────────────────────

export interface CategoryStatusRow {
  category: string;
  /** Any ResultStatus value; only 'passed' / 'failed' / 'errored' are counted distinctly, everything else falls into the bar's `total` only (pending/running cases). */
  status: string;
}

export interface CategoryBar {
  category: string;
  passed: number;
  failed: number;
  errored: number;
  total: number;
}

const UNCATEGORIZED = 'Uncategorized';

/**
 * Group rows by test-case category and tally pass/fail/errored/total.
 * Deterministic order: largest category first, ties broken alphabetically.
 */
export function computeCategoryBars(rows: CategoryStatusRow[]): CategoryBar[] {
  const map = new Map<string, CategoryBar>();
  for (const row of rows) {
    const category = (row.category || '').trim() || UNCATEGORIZED;
    let bar = map.get(category);
    if (!bar) {
      bar = { category, passed: 0, failed: 0, errored: 0, total: 0 };
      map.set(category, bar);
    }
    bar.total++;
    if (row.status === 'passed') bar.passed++;
    else if (row.status === 'errored') bar.errored++;
    else if (row.status === 'failed') bar.failed++;
  }
  return Array.from(map.values()).sort(
    (a, b) => b.total - a.total || a.category.localeCompare(b.category)
  );
}

// ── Failure-theme clustering ───────────────────────────────────────────────

/**
 * Normalize a judge-reasoning string down to its first sentence,
 * lowercased, punctuation-stripped, whitespace-collapsed. Used both as the
 * clustering input and as the theme's stable `key`.
 */
export function normalizeReasoningKey(reasoning: string): string {
  const trimmed = (reasoning || '').trim();
  if (!trimmed) return '';
  const sentenceMatch = trimmed.match(/^[^.!?\n]+[.!?]?/);
  const firstSentence = (sentenceMatch ? sentenceMatch[0] : trimmed).toLowerCase();
  return firstSentence.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns the literal (non-lowercased) first sentence, trimmed — used as the human-facing sample snippet. */
function literalFirstSentence(reasoning: string): string {
  const trimmed = (reasoning || '').trim();
  if (!trimmed) return '';
  const sentenceMatch = trimmed.match(/^[^.!?\n]+[.!?]?/);
  return (sentenceMatch ? sentenceMatch[0] : trimmed).trim();
}

function shingles(normalized: string, size: number): string[] {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= size) return [words.join(' ')];
  const out: string[] = [];
  for (let i = 0; i <= words.length - size; i++) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}

export interface FailureThemeInput {
  testCaseId: string;
  reasoning: string;
}

export interface FailureTheme {
  /** Stable cluster key — the normalized first sentence of the theme's representative case. */
  key: string;
  count: number;
  /** Trimmed, human-readable first sentence sampled from the theme's most common exact phrasing. */
  sampleSnippet: string;
  testCaseIds: string[];
}

/** Contiguous-word window size used for near-duplicate matching. Paraphrases of the same failure ("agent was unable to retrieve..." vs "agent failed to retrieve...") reliably share at least one 6-word run even when their leading words differ. */
const DEFAULT_SHINGLE_SIZE = 6;
/** Reasoning first-sentences shorter than this many words don't carry enough signal to safely dedupe against unrelated failures — left as their own singleton theme rather than risk clustering unrelated short reasons together (e.g. "The agent failed to retrieve the required information."). */
const MIN_WORDS_FOR_SHINGLING = 3;

/**
 * Cluster failing test cases into "why they failed" themes using a
 * deterministic, LLM-free heuristic: normalize each case's judge-reasoning
 * first sentence, then union-find cases that share at least one contiguous
 * N-word shingle. This is robust to minor paraphrasing (a judge saying
 * "unable to retrieve" vs "failed to retrieve" the same underlying tool
 * connectivity failure) while still keeping genuinely distinct failure
 * modes (e.g. "missing required facts" vs "MCP server unavailable")
 * separate, because they share no contiguous phrase.
 *
 * Verified against a real production run (418-verify, 64 failing cases):
 * 57 of 64 connectivity-flavored reasonings collapse into ONE dominant
 * theme; the remaining 7 ("Required facts evaluation: ...", a genuinely
 * different failure shape) form a second, correctly separate theme.
 *
 * Output order: largest theme first, ties broken by the theme's
 * lowest-sorting testCaseId (deterministic, no dependency on input order).
 */
export function clusterFailureThemes(
  items: FailureThemeInput[],
  shingleSize: number = DEFAULT_SHINGLE_SIZE
): FailureTheme[] {
  const n = items.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  const normalized = items.map(it => normalizeReasoningKey(it.reasoning));
  const shingleBuckets = new Map<string, number>(); // shingle -> first index seen
  normalized.forEach((norm, idx) => {
    const words = norm.split(' ').filter(Boolean);
    if (words.length < MIN_WORDS_FOR_SHINGLING) return;
    for (const sh of shingles(norm, shingleSize)) {
      const firstIdx = shingleBuckets.get(sh);
      if (firstIdx === undefined) shingleBuckets.set(sh, idx);
      else union(firstIdx, idx);
    }
  });

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  }

  const themes: FailureTheme[] = [];
  for (const idxs of groups.values()) {
    // Representative snippet: the most frequent literal first-sentence
    // phrasing within the cluster (ties broken by first occurrence) - so a
    // theme with 4 identical sentences + a handful of near-duplicate
    // paraphrases surfaces the exact sentence, not an arbitrary member.
    const counts = new Map<string, { count: number; firstIdx: number; snippet: string }>();
    for (const idx of idxs) {
      const key = normalized[idx];
      const snippet = literalFirstSentence(items[idx].reasoning);
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { count: 1, firstIdx: idx, snippet });
    }
    let best: { count: number; firstIdx: number; snippet: string } | null = null;
    for (const v of counts.values()) {
      if (!best || v.count > best.count || (v.count === best.count && v.firstIdx < best.firstIdx)) best = v;
    }
    const testCaseIds = idxs.map(idx => items[idx].testCaseId);
    themes.push({
      key: normalized[idxs[0]] || `theme-${idxs[0]}`,
      count: idxs.length,
      sampleSnippet: best?.snippet || '',
      testCaseIds,
    });
  }

  themes.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const aMin = [...a.testCaseIds].sort()[0] || '';
    const bMin = [...b.testCaseIds].sort()[0] || '';
    return aMin < bMin ? -1 : aMin > bMin ? 1 : 0;
  });
  return themes;
}

/**
 * "Based on N of M failing cases" note shown under the theme list when the
 * reasoning fetch was capped (RunInsightsPane caps at the first 100 failing
 * cases). Returns null when nothing was capped (fetchedCount >= totalCount).
 */
export function formatCappedNote(fetchedCount: number, totalFailingCount: number): string | null {
  if (totalFailingCount <= fetchedCount) return null;
  return `Based on ${fetchedCount} of ${totalFailingCount} failing cases`;
}

// ── Slowest / costliest ─────────────────────────────────────────────────

export interface RankedCase {
  testCaseId: string;
  value: number;
}

/**
 * Top-N cases by a numeric value (duration, cost, ...), descending.
 * Cases with a null/undefined/NaN value are excluded. Deterministic tie
 * break: lower testCaseId first.
 */
export function pickTopN(cases: { testCaseId: string; value: number | null | undefined }[], n: number): RankedCase[] {
  return cases
    .filter((c): c is RankedCase => typeof c.value === 'number' && Number.isFinite(c.value))
    .sort((a, b) => (b.value !== a.value ? b.value - a.value : a.testCaseId.localeCompare(b.testCaseId)))
    .slice(0, n);
}
