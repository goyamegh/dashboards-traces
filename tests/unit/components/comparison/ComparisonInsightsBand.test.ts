/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * @jest-environment jsdom
 */

/**
 * Regression coverage for the WixQA-400 compare-page gap: a benchmark whose
 * test cases carry a real, VARYING top-level `category:` label (WixQA-400:
 * `category:expertwritten`/`category:simulated`, 200/200) but no `[bracket]`
 * name tag or `topic:` label used to make the entire "By category" section
 * vanish with no trace — extractRowCategory() ignores plain `category:` by
 * design (it assumes a benchmark's category is a coarse, uniform label like
 * `category:RAG`, which would be a useless single-column matrix). That
 * assumption is wrong when category: actually varies, so
 * `categoryLabelIsUsableFallback()` + `extractRowCategoryEffective()`
 * (lib/comparisonInsights.ts) now use `category:` as a facet ONLY when
 * every row is otherwise uncategorized AND the label varies (≥2 distinct
 * values) — preserving the original anti-noise intent for the common
 * "category:RAG on everything" shape, which must still stay hidden (or show
 * the empty-state, if genuinely nothing else exists either).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ComparisonInsightsBand } from '@/components/comparison/ComparisonInsightsBand';
import type { TestCaseComparisonRow } from '@/types';

const h = React.createElement;

const RUN_A = 'eval-run-a';
const RUN_B = 'eval-run-b';

function row(
  id: string,
  name: string,
  verdicts: Record<string, 'passed' | 'failed' | 'missing'>,
  labels: string[] = []
): TestCaseComparisonRow {
  const results: TestCaseComparisonRow['results'] = {};
  for (const [runId, v] of Object.entries(verdicts)) {
    results[runId] = v === 'missing' ? { status: 'missing' } : { status: 'completed', passFailStatus: v };
  }
  return {
    testCaseId: id,
    testCaseName: name,
    labels,
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    results,
    hasVersionDifference: false,
    versions: [],
  };
}

const noop = () => {};

describe('ComparisonInsightsBand — category:-label fallback (WixQA-400 fix)', () => {
  it('renders nothing for a single selected run', () => {
    const rows = [row('tc-1', 'q1', { [RUN_A]: 'passed' }, ['category:expertwritten'])];
    const { container } = render(
      h(ComparisonInsightsBand, {
        rows,
        runIds: [RUN_A],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a REAL matrix with the category: values as columns for the WixQA-400 shape (varying category:, no [bracket]/topic)', () => {
    // Shape of WixQA-400: names like "wixqa_expertwritten_0" (no [bracket]),
    // labels like ["category:expertwritten"] (no "topic:", no bracket tag) —
    // but category: DOES vary (expertwritten vs simulated), so it's a real,
    // useful facet, not the "coarse label on everything" case.
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 0; i < 6; i++) {
      const cat = i < 3 ? 'expertwritten' : 'simulated';
      rows.push(
        row(`tc-${i}`, `wixqa_${cat}_${i}`, { [RUN_A]: i % 2 === 0 ? 'passed' : 'failed', [RUN_B]: 'passed' }, [
          `category:${cat}`,
        ])
      );
    }

    render(
      h(ComparisonInsightsBand, {
        rows,
        runIds: [RUN_A, RUN_B],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );

    // Agreement chips are unaffected either way.
    expect(screen.getByTestId('agreement-chip-allPass')).toBeTruthy();
    expect(screen.getByTestId('agreement-chip-allFail')).toBeTruthy();
    expect(screen.getByTestId('agreement-chip-split')).toBeTruthy();

    // The REAL matrix must render — not the empty-state.
    const matrix = screen.getByTestId('insights-category-matrix');
    expect(matrix).toBeTruthy();
    expect(screen.queryByTestId('insights-categories-empty')).toBeNull();
    expect(matrix.textContent).toMatch(/expertwritten/);
    expect(matrix.textContent).toMatch(/simulated/);
  });

  it('does NOT fall back (empty-state, not a redundant 1-column matrix) when category: is uniform and no [bracket]/topic facet exists', () => {
    // The classic "category:RAG stamped on every case" shape the original
    // heuristic was written for — must stay hidden-with-explanation, not
    // grow a pointless single-value column.
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(row(`tc-${i}`, `case_${i}`, { [RUN_A]: 'passed', [RUN_B]: 'passed' }, ['category:RAG']));
    }

    render(
      h(ComparisonInsightsBand, {
        rows,
        runIds: [RUN_A, RUN_B],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );

    expect(screen.queryByTestId('insights-category-matrix')).toBeNull();
    const empty = screen.getByTestId('insights-categories-empty');
    expect(empty.textContent).toMatch(/no category breakdown/i);
  });

  it('shows the "too few cases per facet" empty-state when every real facet rolls into (other)', () => {
    // 40 rows (so MIN_CATEGORY_CASES=5 applies), each [bracket] tag has only
    // 2 cases — everything rolls into the (other) bucket, which alone
    // doesn't count as a "meaningful" category either.
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 0; i < 40; i++) {
      const tag = `tiny-${Math.floor(i / 2)}`; // 20 distinct tags, 2 cases each
      rows.push(row(`tc-${i}`, `q${i} [${tag}] some question`, { [RUN_A]: 'passed', [RUN_B]: 'passed' }, []));
    }

    render(
      h(ComparisonInsightsBand, {
        rows,
        runIds: [RUN_A, RUN_B],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );

    expect(screen.queryByTestId('insights-category-matrix')).toBeNull();
    const empty = screen.getByTestId('insights-categories-empty');
    expect(empty.textContent).toMatch(/no category breakdown/i);
    expect(empty.textContent).toMatch(/fewer than \d+ cases/i);
  });

  it('renders the real matrix (no empty-state) once a [bracket] name tag is present, same as EnterpriseRAG-84', () => {
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 0; i < 6; i++) {
      const sub = i < 3 ? 'info_not_found' : 'single_hop';
      rows.push(
        row(`tc-${i}`, `qst_0${i} [${sub}] some question`, { [RUN_A]: 'passed', [RUN_B]: 'passed' }, ['category:RAG'])
      );
    }

    render(
      h(ComparisonInsightsBand, {
        rows,
        runIds: [RUN_A, RUN_B],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );

    expect(screen.getByTestId('insights-category-matrix')).toBeTruthy();
    expect(screen.queryByTestId('insights-categories-empty')).toBeNull();
    expect(screen.getByTestId('insights-category-matrix').textContent).toMatch(/info_not_found/);
    expect(screen.getByTestId('insights-category-matrix').textContent).toMatch(/single_hop/);
  });

  it("shows neither the matrix nor the empty-state when there are no shared rows (that gap is ComparisonOverlapBanner's job)", () => {
    render(
      h(ComparisonInsightsBand, {
        rows: [],
        runIds: [RUN_A, RUN_B],
        getRunName: (id: string) => id,
        agreementFilter: null,
        onAgreementFilter: noop,
        categoryFilter: null,
        onCategoryFilter: noop,
      })
    );
    expect(screen.queryByTestId('insights-category-matrix')).toBeNull();
    expect(screen.queryByTestId('insights-categories-empty')).toBeNull();
    // The band itself (agreement chips) still renders for >=2 runs.
    expect(screen.getByTestId('comparison-insights-band')).toBeTruthy();
  });
});
