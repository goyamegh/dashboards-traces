/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison deep-dive — deterministic context builder.
 *
 * The N-run (2–4) deep-dive cannot afford to show the LLM every test case of
 * every run (84 cases × 4 runs × ~30 spans ≈ millions of tokens). Instead the
 * frontend sends the shared-case verdict matrix and THIS module — plain code,
 * no LLM — compresses it into a small, high-signal prompt prefix:
 *
 *   1. Agreement partition: all-pass / all-fail / split (+ incomplete) counts.
 *      Split and all-fail cases carry ~all the information; all-pass cases
 *      carry almost none (they agree, and the headline pass rates already
 *      summarize them).
 *   2. Per-run totals + median case duration — computed here, never counted
 *      by the model (LLMs miscount; code doesn't).
 *   3. Per-category pass-rate table, category parsed from the test-case
 *      name's "[tag]" convention (e.g. "qst_0011 [basic] How long …"), since
 *      the labels array often only carries a generic label.
 *   4. Information-value case sampling: one-line summaries for split cases
 *      and all-fail cases (capped), ONE all-pass exemplar, everything else
 *      dropped.
 *   5. Budget guardrail: a hard character cap with an explicit drop order —
 *      exemplar → category table → all-fail overflow → split overflow →
 *      partition-only fallback.
 *
 * It also nominates the "focus cases" (split first, then all-fail, capped)
 * whose per-run reports the route resolves so the agent can drill into their
 * real spans on demand (query_spans { run, caseId }) instead of pre-fetching
 * every case's traces.
 *
 * Pure + deterministic → unit-testable without any model or cluster.
 */

export type CaseVerdict = 'pass' | 'fail' | 'error' | 'missing';

/** One shared test case row of the comparison matrix (frontend-supplied). */
export interface ComparisonCaseInput {
  id: string;
  name: string;
  /** Verdict per run, aligned with the run-key order (A, B, C, D). */
  verdicts: CaseVerdict[];
  /** Agent wall-clock duration per run (ms), aligned with run keys. */
  durationsMs?: Array<number | null | undefined>;
  /** Per-run report ids, aligned with run keys (for focus-case drill-down). */
  reportIds?: Array<string | null | undefined>;
}

export interface ComparisonRunMetaInput {
  key: string; // 'A' | 'B' | 'C' | 'D'
  label: string; // agent display name
}

export interface ComparisonContextOptions {
  /** Max split-case one-liners in the prefix. */
  maxSplitCases?: number;
  /** Max all-fail one-liners in the prefix. */
  maxAllFailCases?: number;
  /** Max focus cases whose reports get resolved for span drill-down. */
  maxFocusCases?: number;
  /** Hard cap on the prefix text, in characters (~4 chars/token). */
  maxPrefixChars?: number;
}

export interface ComparisonPartition {
  allPass: ComparisonCaseInput[];
  allFail: ComparisonCaseInput[];
  split: ComparisonCaseInput[];
  /** Cases where some run has an 'error' or 'missing' verdict. */
  incomplete: ComparisonCaseInput[];
}

export interface ComparisonContext {
  /** Deterministic prompt prefix ('' when no cases were supplied). */
  prefixText: string;
  /** Case ids nominated for span drill-down (split first, then all-fail). */
  focusCaseIds: string[];
  partition: ComparisonPartition;
}

export const DEFAULT_CONTEXT_OPTIONS: Required<ComparisonContextOptions> = {
  maxSplitCases: 24,
  maxAllFailCases: 8,
  maxFocusCases: 6,
  maxPrefixChars: 8000,
};

const CASE_NAME_MAX = 80;
const MIN_SPLIT_LINES = 8; // never trim split lines below this before falling back

/** Parse the "[tag]" category convention out of a test-case name. */
export function parseCategoryTag(name: string): string | undefined {
  const m = /\[([^\]]+)\]/.exec(name || '');
  const tag = m?.[1]?.trim();
  return tag ? tag.toLowerCase() : undefined;
}

/** Partition shared cases by cross-run agreement. */
export function partitionCases(cases: ComparisonCaseInput[]): ComparisonPartition {
  const partition: ComparisonPartition = { allPass: [], allFail: [], split: [], incomplete: [] };
  for (const c of cases) {
    const verdicts = c.verdicts || [];
    if (verdicts.length === 0 || verdicts.some((v) => v !== 'pass' && v !== 'fail')) {
      partition.incomplete.push(c);
    } else if (verdicts.every((v) => v === 'pass')) {
      partition.allPass.push(c);
    } else if (verdicts.every((v) => v === 'fail')) {
      partition.allFail.push(c);
    } else {
      partition.split.push(c);
    }
  }
  return partition;
}

export function median(values: number[]): number | undefined {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function truncateName(name: string): string {
  const n = (name || '').replace(/\s+/g, ' ').trim();
  return n.length > CASE_NAME_MAX ? `${n.slice(0, CASE_NAME_MAX - 1)}…` : n;
}

function fmtSeconds(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(0)}s` : '?';
}

const VERDICT_MARK: Record<CaseVerdict, string> = {
  pass: '✓',
  fail: '✗',
  error: 'E',
  missing: '–',
};

/** One-line summary: "qst_0042 [semantic] What is… — A✓ B✗ C✓ (41s/38s/52s)". */
function caseLine(c: ComparisonCaseInput, keys: string[]): string {
  const marks = keys.map((k, i) => `${k}${VERDICT_MARK[c.verdicts[i]] ?? '?'}`).join(' ');
  const durations = (c.durationsMs || []).some((d) => typeof d === 'number')
    ? ` (${keys.map((_, i) => fmtSeconds(c.durationsMs?.[i])).join('/')})`
    : '';
  return `- [${c.id}] ${truncateName(c.name)} — ${marks}${durations}`;
}

function passRate(passed: number, total: number): string {
  return total > 0 ? `${Math.round((passed / total) * 100)}%` : '—';
}

/** Per-category pass-rate table rows, categories ordered by case count desc. */
function buildCategoryTable(runs: ComparisonRunMetaInput[], cases: ComparisonCaseInput[]): string[] {
  const byCategory = new Map<string, ComparisonCaseInput[]>();
  for (const c of cases) {
    const cat = parseCategoryTag(c.name) ?? 'uncategorized';
    const list = byCategory.get(cat) ?? [];
    list.push(c);
    byCategory.set(cat, list);
  }
  if (byCategory.size <= 1) return []; // a single bucket adds nothing over the totals
  const categories = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines = [
    `| category | cases | ${runs.map((r) => r.key).join(' | ')} |`,
    `|---|---|${runs.map(() => '---').join('|')}|`,
  ];
  for (const [cat, catCases] of categories) {
    const rates = runs.map((_, i) => {
      const graded = catCases.filter((c) => c.verdicts[i] === 'pass' || c.verdicts[i] === 'fail');
      const passed = graded.filter((c) => c.verdicts[i] === 'pass').length;
      return passRate(passed, graded.length);
    });
    lines.push(`| ${cat} | ${catCases.length} | ${rates.join(' | ')} |`);
  }
  return lines;
}

/**
 * Build the deterministic prompt prefix + focus-case nomination for an N-run
 * comparison. Returns an empty prefix when no case matrix was supplied.
 */
export function buildComparisonContext(
  runs: ComparisonRunMetaInput[],
  cases: ComparisonCaseInput[],
  options?: ComparisonContextOptions
): ComparisonContext {
  const opts = { ...DEFAULT_CONTEXT_OPTIONS, ...(options || {}) };
  const partition = partitionCases(cases);
  if (cases.length === 0) {
    return { prefixText: '', focusCaseIds: [], partition };
  }

  const keys = runs.map((r) => r.key);

  // Focus cases: split cases are the highest-information, then shared failures.
  const focusCaseIds = [...partition.split, ...partition.allFail]
    .slice(0, opts.maxFocusCases)
    .map((c) => c.id);

  // Per-run totals + median durations (computed in code — the prompt tells the
  // model to trust these instead of recounting).
  const runSummaries = runs.map((r, i) => {
    const graded = cases.filter((c) => c.verdicts[i] === 'pass' || c.verdicts[i] === 'fail');
    const passed = graded.filter((c) => c.verdicts[i] === 'pass').length;
    const med = median(
      cases.map((c) => c.durationsMs?.[i]).filter((d): d is number => typeof d === 'number')
    );
    const medStr = med !== undefined ? `, median case duration ${fmtSeconds(med)}` : '';
    return `${r.key} = ${r.label} (${passed}/${graded.length} passed${medStr})`;
  });

  const header = [
    '## Shared results overview (computed deterministically in code — trust these numbers, do NOT recount them from spans)',
    `Runs: ${runSummaries.join(' · ')}`,
    `Agreement across ${cases.length} shared cases: ${partition.allPass.length} all-pass · ${partition.allFail.length} all-fail · ${partition.split.length} split` +
      (partition.incomplete.length ? ` · ${partition.incomplete.length} incomplete (errored/missing verdicts)` : ''),
  ];

  const categoryTable = buildCategoryTable(runs, cases);
  const categorySection = categoryTable.length
    ? ['', 'Per-category pass rates (category parsed from the test-case name tag):', ...categoryTable]
    : [];

  const splitAll = partition.split.map((c) => caseLine(c, keys));
  const failAll = partition.allFail.map((c) => caseLine(c, keys));

  const buildSplitSection = (lines: string[], total: number) =>
    lines.length
      ? [
          '',
          `### Split cases — runs disagree (the interesting ones; showing ${lines.length} of ${total})`,
          ...lines,
        ]
      : [];
  const buildFailSection = (lines: string[], total: number) =>
    lines.length
      ? ['', `### All-fail cases — shared weaknesses (showing ${lines.length} of ${total})`, ...lines]
      : [];
  const buildExemplar = () =>
    partition.allPass.length
      ? [
          '',
          `### All-pass exemplar (representative of the ${partition.allPass.length} cases every run passed)`,
          caseLine(partition.allPass[0], keys),
        ]
      : [];

  // Assemble at the configured caps, then trim in explicit drop order until we
  // fit the hard character budget.
  let splitLines = splitAll.slice(0, opts.maxSplitCases);
  let failLines = failAll.slice(0, opts.maxAllFailCases);
  let includeExemplar = true;
  let includeCategoryTable = categorySection.length > 0;

  const assemble = () =>
    [
      ...header,
      ...(includeCategoryTable ? categorySection : []),
      ...buildSplitSection(splitLines, splitAll.length),
      ...buildFailSection(failLines, failAll.length),
      ...(includeExemplar ? buildExemplar() : []),
    ].join('\n');

  let text = assemble();
  const overBudget = () => text.length > opts.maxPrefixChars;

  // Drop order: exemplar → category table → all-fail overflow → split overflow.
  if (overBudget() && includeExemplar) {
    includeExemplar = false;
    text = assemble();
  }
  if (overBudget() && includeCategoryTable) {
    includeCategoryTable = false;
    text = assemble();
  }
  while (overBudget() && failLines.length > 0) {
    failLines = failLines.slice(0, failLines.length - 1);
    text = assemble();
  }
  while (overBudget() && splitLines.length > MIN_SPLIT_LINES) {
    splitLines = splitLines.slice(0, splitLines.length - 1);
    text = assemble();
  }
  if (overBudget()) {
    // Fallback: partition + totals only — always tiny.
    text = header.join('\n');
  }

  return { prefixText: text, focusCaseIds, partition };
}
