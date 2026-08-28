/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  partitionByAgreement,
  bucketRow,
  extractRowCategory,
  categoryLabelIsUsableFallback,
  extractRowCategoryEffective,
  buildCategoryBreakdown,
  detectSharedWeakness,
  UNCATEGORIZED,
  OTHER_CATEGORY,
} from '@/lib/comparisonInsights';
import type { TestCaseComparisonRow } from '@/types';

const RUN_A = 'run-a';
const RUN_B = 'run-b';
const RUN_C = 'run-c';

function row(
  id: string,
  name: string,
  verdicts: Record<string, 'passed' | 'failed' | 'errored' | 'missing'>,
  labels: string[] = []
): TestCaseComparisonRow {
  const results: TestCaseComparisonRow['results'] = {};
  for (const [runId, v] of Object.entries(verdicts)) {
    if (v === 'missing') {
      results[runId] = { status: 'missing' };
    } else if (v === 'errored') {
      results[runId] = { status: 'completed', errored: true };
    } else {
      results[runId] = { status: 'completed', passFailStatus: v };
    }
  }
  return {
    testCaseId: id,
    testCaseName: name,
    labels,
    category: 'Unknown' as any,
    difficulty: 'Medium' as any,
    results,
    hasVersionDifference: false,
    versions: [],
  };
}

describe('partitionByAgreement', () => {
  it('buckets 2-run rows into allPass / allFail / split / uncovered', () => {
    const rows = [
      row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
      row('t2', 't2', { [RUN_A]: 'failed', [RUN_B]: 'failed' }),
      row('t3', 't3', { [RUN_A]: 'passed', [RUN_B]: 'failed' }),
      row('t4', 't4', { [RUN_A]: 'failed', [RUN_B]: 'passed' }),
      row('t5', 't5', { [RUN_A]: 'passed', [RUN_B]: 'missing' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B]);
    expect(p.allPass.map(r => r.testCaseId)).toEqual(['t1']);
    expect(p.allFail.map(r => r.testCaseId)).toEqual(['t2']);
    expect(p.split.map(r => r.testCaseId)).toEqual(['t3', 't4']);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t5']);
  });

  it('treats evaluator-errored results as NO verdict (uncovered), not as fails (#242 semantics)', () => {
    // "The judge broke" must not be conflated with "the agent failed" —
    // otherwise infrastructure noise poisons the All-fail bucket.
    const rows = [
      row('t1', 't1', { [RUN_A]: 'errored', [RUN_B]: 'failed' }),
      row('t2', 't2', { [RUN_A]: 'errored', [RUN_B]: 'passed' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B]);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t1', 't2']);
    expect(p.allFail).toHaveLength(0);
    expect(p.split).toHaveLength(0);
  });

  it('treats a run-level failure (status failed, no judge verdict) as a fail verdict', () => {
    const r1: TestCaseComparisonRow = row('t1', 't1', { [RUN_B]: 'passed' });
    r1.results[RUN_A] = { status: 'failed' };
    const p = partitionByAgreement([r1], [RUN_A, RUN_B]);
    expect(p.split.map(r => r.testCaseId)).toEqual(['t1']);
  });

  it('treats a completed result with NO verdict at all as uncovered', () => {
    const r1: TestCaseComparisonRow = row('t1', 't1', { [RUN_B]: 'passed' });
    r1.results[RUN_A] = { status: 'completed' }; // no passFailStatus, not errored
    const p = partitionByAgreement([r1], [RUN_A, RUN_B]);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t1']);
  });

  it('generalizes to 3 runs: split = any mix of pass and fail', () => {
    const rows = [
      row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'passed', [RUN_C]: 'passed' }),
      row('t2', 't2', { [RUN_A]: 'passed', [RUN_B]: 'passed', [RUN_C]: 'failed' }),
      row('t3', 't3', { [RUN_A]: 'failed', [RUN_B]: 'failed', [RUN_C]: 'failed' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B, RUN_C]);
    expect(p.allPass).toHaveLength(1);
    expect(p.split).toHaveLength(1);
    expect(p.allFail).toHaveLength(1);
  });

  it('bucketRow matches the partition semantics', () => {
    const r1 = row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'failed' });
    const r2 = row('t2', 't2', { [RUN_A]: 'passed', [RUN_B]: 'missing' });
    expect(bucketRow(r1, [RUN_A, RUN_B])).toBe('split');
    expect(bucketRow(r2, [RUN_A, RUN_B])).toBeNull();
  });
});

describe('extractRowCategory', () => {
  it('parses the bracketed tag from imported-benchmark names', () => {
    expect(extractRowCategory(row('t', 'qst_0011 [basic] How long…', {}))).toBe('basic');
    expect(extractRowCategory(row('t', 'qst_0492 [info_not_found] For the…', {}))).toBe('info_not_found');
  });

  it('falls back to topic: labels, then uncategorized', () => {
    expect(extractRowCategory(row('t', 'no tag here', {}, ['topic:Retrieval']))).toBe('retrieval');
    // category:RAG is deliberately ignored — it is stamped on every imported case
    expect(extractRowCategory(row('t', 'no tag here', {}, ['category:RAG']))).toBe(UNCATEGORIZED);
  });

  // The proper, purpose-built tag — set via the SDK's `labels`, the
  // JSON/CLI import's `subcategory` field, or the Test Case editor (see
  // lib/testCaseLabels.ts's getSubcategoryFromLabels). Preferred over
  // anything scraped from free text.
  it('prefers the subcategory: label over the name-bracket tag and topic:', () => {
    expect(extractRowCategory(row('t', 'no tag in this name', {}, ['subcategory:basic']))).toBe('basic');
    // Wins even when the name ALSO has a (stale/different) bracket tag.
    expect(
      extractRowCategory(row('t', 'qst_0011 [semantic] some question', {}, ['subcategory:basic']))
    ).toBe('basic');
    // Wins over topic: too.
    expect(
      extractRowCategory(row('t', 'no tag here', {}, ['subcategory:basic', 'topic:Retrieval']))
    ).toBe('basic');
  });

  it('falls back to the name-bracket tag when no subcategory label is set (legacy benchmarks)', () => {
    expect(extractRowCategory(row('t', 'qst_0011 [basic] How long…', {}, ['category:RAG']))).toBe('basic');
  });

  it('lowercases the subcategory value for consistent grouping/display', () => {
    expect(extractRowCategory(row('t', 'q', {}, ['subcategory:Basic']))).toBe('basic');
  });

  it('ignores an empty subcategory: label (falls through to the next signal)', () => {
    expect(extractRowCategory(row('t', 'qst_0011 [basic] q', {}, ['subcategory:']))).toBe('basic');
  });
});

describe('categoryLabelIsUsableFallback / extractRowCategoryEffective', () => {
  it('is false when any row already has a real bracket/topic facet (existing behavior untouched)', () => {
    const rows = [
      row('t1', 'q [basic] 1', {}, ['category:RAG']),
      row('t2', 'no tag', {}, ['category:RAG']),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(false);
    // extractRowCategoryEffective with fallback disabled == extractRowCategory
    expect(extractRowCategoryEffective(rows[0], false)).toBe('basic');
    expect(extractRowCategoryEffective(rows[1], false)).toBe(UNCATEGORIZED);
  });

  it('is false when every row is uncategorized but category: is uniform (the classic "category:RAG on everything" shape)', () => {
    // This is exactly the case the original "category: intentionally NOT
    // used" heuristic was protecting against: a single coarse label stamped
    // on every case must NOT produce a redundant one-column matrix.
    const rows = [1, 2, 3].map(i => row(`t${i}`, 'no tag', {}, ['category:RAG']));
    expect(categoryLabelIsUsableFallback(rows)).toBe(false);
    expect(extractRowCategoryEffective(rows[0], categoryLabelIsUsableFallback(rows))).toBe(UNCATEGORIZED);
  });

  it('is true when every row is uncategorized AND category: varies (the WixQA-400 shape: expertwritten/simulated)', () => {
    const rows = [
      ...[1, 2, 3].map(i => row(`e${i}`, `wixqa_expertwritten_${i}`, {}, ['category:expertwritten'])),
      ...[1, 2, 3].map(i => row(`s${i}`, `wixqa_simulated_${i}`, {}, ['category:simulated'])),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(true);
    const fallback = categoryLabelIsUsableFallback(rows);
    expect(extractRowCategoryEffective(rows[0], fallback)).toBe('expertwritten');
    expect(extractRowCategoryEffective(rows[3], fallback)).toBe('simulated');
  });

  it('is false for an empty row set', () => {
    expect(categoryLabelIsUsableFallback([])).toBe(false);
  });

  it('ignores rows with no category: label at all when computing variance (only counts REAL values)', () => {
    // 2 rows tagged category:RAG, 1 row with no category label whatsoever —
    // only one distinct REAL value exists, so this must NOT count as "varies".
    const rows = [
      row('t1', 'no tag', {}, ['category:RAG']),
      row('t2', 'no tag', {}, ['category:RAG']),
      row('t3', 'no tag', {}),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(false);
  });

  // Regression coverage for codex_review findings on the first version of
  // this fallback (severity HIGH/MED — see PR #449's review thread).
  it('normalizes case before checking variance — category:RAG and category:rag must NOT count as 2 distinct values', () => {
    // Without lowercasing before the Set/Map, inconsistent casing on an
    // otherwise-uniform category would wrongly enable the fallback and
    // produce a redundant single-column matrix (extractRowCategoryEffective
    // lowercases when it RESOLVES a category — the variance CHECK must use
    // the exact same normalization or the two can disagree).
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`u${i}`, 'no tag', {}, ['category:RAG'])),
      ...Array.from({ length: 5 }, (_, i) => row(`l${i}`, 'no tag', {}, ['category:rag'])),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(false);
    // All 10 resolve to the SAME effective category once fallback would be
    // considered — confirms they were never meant to be "2 distinct values".
    const effective = new Set(rows.map(r => extractRowCategoryEffective(r, true)));
    expect(effective).toEqual(new Set(['rag']));
  });

  it('does not enable the fallback for one differently-tagged row when every OTHER row is uncategorized and category: varies (mixed-convention benchmark)', () => {
    // A single [bracket]-tagged row must not disable the fallback for every
    // OTHER row that has nothing better than category: to group by.
    const rows = [
      row('br1', 'q [custom] one-off case', {}, ['category:RAG']), // has its own real facet
      ...Array.from({ length: 3 }, (_, i) => row(`e${i}`, `wixqa_expertwritten_${i}`, {}, ['category:expertwritten'])),
      ...Array.from({ length: 3 }, (_, i) => row(`s${i}`, `wixqa_simulated_${i}`, {}, ['category:simulated'])),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(true);
    // The bracketed row keeps its OWN facet regardless of the fallback flag.
    expect(extractRowCategoryEffective(rows[0], true)).toBe('custom');
    // The other rows use the category: fallback.
    expect(extractRowCategoryEffective(rows[1], true)).toBe('expertwritten');
    expect(extractRowCategoryEffective(rows[4], true)).toBe('simulated');
  });

  it('requires each candidate category: value to appear on >=2 rows — a single stray/typo value cannot flip the fallback on', () => {
    // 5 rows category:RAG (real, dominant), 1 row category:rag-typo (a lone
    // data-quality glitch) — must resolve like a uniform category, not like
    // "2 distinct values that vary".
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`r${i}`, 'no tag', {}, ['category:RAG'])),
      row('typo', 'no tag', {}, ['category:rag-typo']),
    ];
    expect(categoryLabelIsUsableFallback(rows)).toBe(false);
  });
});

describe('buildCategoryBreakdown', () => {
  const rows = [
    ...[1, 2, 3, 4, 5].map(i =>
      row(`b${i}`, `q [basic] ${i}`, { [RUN_A]: i <= 4 ? 'passed' : 'failed', [RUN_B]: 'passed' } as any)
    ),
    ...[1, 2, 3, 4, 5].map(i =>
      row(`s${i}`, `q [semantic] ${i}`, { [RUN_A]: i <= 2 ? 'passed' : 'failed', [RUN_B]: i <= 3 ? 'passed' : 'failed' } as any)
    ),
    row('m1', 'q [misc] 1', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
  ];

  it('computes per-run rates and rolls small categories into (other)', () => {
    const b = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    expect(b.categories).toEqual(['basic', 'semantic', OTHER_CATEGORY]);
    expect(b.perRun[RUN_A].basic).toEqual({ passed: 4, total: 5 });
    expect(b.perRun[RUN_A].semantic).toEqual({ passed: 2, total: 5 });
    expect(b.perRun[RUN_B].semantic).toEqual({ passed: 3, total: 5 });
    expect(b.perRun[RUN_A][OTHER_CATEGORY]).toEqual({ passed: 1, total: 1 });
    // Real bracket-tag facets exist — the category:-label fallback must stay off.
    expect(b.usesCategoryFallback).toBe(false);
  });

  it('falls back to the category: label when no row has a bracket/topic facet AND category: varies (WixQA-400 shape)', () => {
    const wixqaLike = [
      ...Array.from({ length: 6 }, (_, i) =>
        row(`e${i}`, `wixqa_expertwritten_${i}`, { [RUN_A]: i < 4 ? 'passed' : 'failed', [RUN_B]: 'passed' } as any, [
          'category:expertwritten',
        ])
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        row(`s${i}`, `wixqa_simulated_${i}`, { [RUN_A]: i < 2 ? 'passed' : 'failed', [RUN_B]: i < 3 ? 'passed' : 'failed' } as any, [
          'category:simulated',
        ])
      ),
    ];
    const b = buildCategoryBreakdown(wixqaLike, [RUN_A, RUN_B], 2);
    expect(b.usesCategoryFallback).toBe(true);
    expect(b.categories).toEqual(['expertwritten', 'simulated']);
    expect(b.perRun[RUN_A].expertwritten).toEqual({ passed: 4, total: 6 });
    expect(b.perRun[RUN_B].simulated).toEqual({ passed: 3, total: 6 });
    expect(b.members.expertwritten).toEqual(['expertwritten']);
  });

  it('does NOT fall back when category: is uniform and no bracket/topic facet exists (no redundant single-value column)', () => {
    const uniform = Array.from({ length: 6 }, (_, i) =>
      row(`t${i}`, `case_${i}`, { [RUN_A]: 'passed', [RUN_B]: 'passed' } as any, ['category:RAG'])
    );
    const b = buildCategoryBreakdown(uniform, [RUN_A, RUN_B], 2);
    expect(b.usesCategoryFallback).toBe(false);
    expect(b.categories).toEqual([UNCATEGORIZED]);
  });

  it('exposes members so the (other) rollup is filterable with the same semantics it was computed with', () => {
    const b = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    expect(b.members.basic).toEqual(['basic']);
    expect(b.members[OTHER_CATEGORY]).toEqual(['misc']);
  });

  it('a real [other] name tag cannot collide with the synthetic (other) bucket', () => {
    // extractRowCategory only matches [\w-]+ — parentheses in the sentinel
    // names are outside that charset by construction.
    expect(extractRowCategory(row('t', 'q [other] real category', {}))).toBe('other');
    expect('other').not.toBe(OTHER_CATEGORY);
  });

  it('skips runs with missing verdicts in the cell totals', () => {
    const rowsWithGap = [
      row('g1', 'q [basic] g1', { [RUN_A]: 'passed', [RUN_B]: 'missing' }),
      row('g2', 'q [basic] g2', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
    ];
    const b = buildCategoryBreakdown(rowsWithGap, [RUN_A, RUN_B], 1);
    expect(b.perRun[RUN_A].basic).toEqual({ passed: 2, total: 2 });
    expect(b.perRun[RUN_B].basic).toEqual({ passed: 1, total: 1 });
  });
});

describe('detectSharedWeakness', () => {
  function scenario(semanticRates: { a: number; b: number }, basicRates: { a: number; b: number }) {
    // 10 cases per category; rates control how many pass
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push(
        row(`s${i}`, `q [semantic] ${i}`, {
          [RUN_A]: i <= semanticRates.a ? 'passed' : 'failed',
          [RUN_B]: i <= semanticRates.b ? 'passed' : 'failed',
        } as any)
      );
      rows.push(
        row(`b${i}`, `q [basic] ${i}`, {
          [RUN_A]: i <= basicRates.a ? 'passed' : 'failed',
          [RUN_B]: i <= basicRates.b ? 'passed' : 'failed',
        } as any)
      );
    }
    const partition = partitionByAgreement(rows, [RUN_A, RUN_B]);
    const breakdown = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    return detectSharedWeakness(breakdown, partition, [RUN_A, RUN_B]);
  }

  it('flags a category that is the weakest for every run', () => {
    const w = scenario({ a: 6, b: 6 }, { a: 9, b: 9 }); // semantic 60/60, basic 90/90
    expect(w).not.toBeNull();
    expect(w!.category).toBe('semantic');
    expect(w!.rates).toEqual({ [RUN_A]: 60, [RUN_B]: 60 });
    expect(w!.allFailShare).toBeGreaterThan(0);
  });

  it('returns null when runs disagree about their weakest category', () => {
    // semantic weak for A only; basic weak for B only
    const w = scenario({ a: 5, b: 9 }, { a: 9, b: 5 });
    expect(w).toBeNull();
  });

  it('returns null when another category is meaningfully lower for one run (honest "weakest" claim)', () => {
    // For B, basic (40%) is far below semantic (60%) — semantic is NOT B's
    // weakest, so no shared-weakness claim even though semantic has the
    // lower mean? (means: semantic 60, basic 65) — semantic IS mean-weakest
    // but fails the per-run weakest check.
    const w = scenario({ a: 6, b: 6 }, { a: 9, b: 4 });
    expect(w).toBeNull();
  });

  it('returns null when nothing is genuinely weak', () => {
    const w = scenario({ a: 9, b: 8 }, { a: 9, b: 9 }); // 90/80 vs 90/90 — strong everywhere
    expect(w).toBeNull();
  });

  it('computes allFailShare correctly through the category:-label fallback (WixQA-shaped rows, no bracket/topic tags)', () => {
    // Reproduces the WixQA-400 shape end-to-end through detectSharedWeakness:
    // rows carry ONLY category:expertwritten/simulated (no [bracket], no
    // topic:), so this only works if allFailInCat resolves rows via
    // extractRowCategoryEffective(row, breakdown.usesCategoryFallback)
    // instead of the base extractRowCategory (which would see every row as
    // UNCATEGORIZED and silently zero out allFailShare).
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push(
        row(`sim${i}`, `wixqa_simulated_${i}`, { [RUN_A]: i <= 6 ? 'passed' : 'failed', [RUN_B]: i <= 6 ? 'passed' : 'failed' } as any, [
          'category:simulated',
        ])
      );
      rows.push(
        row(`exp${i}`, `wixqa_expertwritten_${i}`, { [RUN_A]: i <= 9 ? 'passed' : 'failed', [RUN_B]: i <= 9 ? 'passed' : 'failed' } as any, [
          'category:expertwritten',
        ])
      );
    }
    const partition = partitionByAgreement(rows, [RUN_A, RUN_B]);
    const breakdown = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    expect(breakdown.usesCategoryFallback).toBe(true);
    const w = detectSharedWeakness(breakdown, partition, [RUN_A, RUN_B]);
    expect(w).not.toBeNull();
    expect(w!.category).toBe('simulated');
    // 5 all-fail cases total (sim7-10 + exp10); 4 of them are 'simulated' —
    // allFailShare must be 0.8, not 0 (the pre-fix bug: re-extracting via the
    // base, non-fallback-aware function would see every row as UNCATEGORIZED
    // and silently zero this out regardless of the real distribution).
    expect(w!.allFailShare).toBe(0.8);
  });
});
