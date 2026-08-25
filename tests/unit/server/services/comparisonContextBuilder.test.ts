/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive deterministic context builder.
 *
 * This module is the budget/signal core of the N-run deep-dive: agreement
 * partition math, category parsing from the "[tag]" name convention,
 * per-run/per-category pass rates, information-value case sampling (split +
 * all-fail; all-pass dropped except one exemplar), and the hard-cap trimming
 * drop order. All pure code — if the LLM ever "recounts" these wrong, these
 * tests are the ground truth for what it was given.
 */

import {
  buildComparisonContext,
  parseCategoryTag,
  partitionCases,
  median,
  DEFAULT_CONTEXT_OPTIONS,
  type ComparisonCaseInput,
  type CaseVerdict,
} from '@/server/services/comparisonContextBuilder';

const RUNS_3 = [
  { key: 'A', label: 'cc-os-rag' },
  { key: 'B', label: 'pi-os-rag' },
  { key: 'C', label: 'logos-os-rag' },
];

let caseSeq = 0;
const makeCase = (
  verdicts: CaseVerdict[],
  overrides: Partial<ComparisonCaseInput> = {}
): ComparisonCaseInput => {
  caseSeq += 1;
  return {
    id: `tc-${caseSeq}`,
    name: `qst_${String(caseSeq).padStart(4, '0')} [basic] Some question about the runbook ${caseSeq}`,
    verdicts,
    ...overrides,
  };
};

beforeEach(() => {
  caseSeq = 0;
});

describe('parseCategoryTag', () => {
  it('parses the [tag] convention out of a test-case name', () => {
    expect(parseCategoryTag('qst_0011 [basic] How long is the validity period')).toBe('basic');
    expect(parseCategoryTag('qst_0042 [Semantic] What is …')).toBe('semantic'); // normalized
    expect(parseCategoryTag('qst_0042 [multi hop] What is …')).toBe('multi hop');
  });

  it('returns undefined when there is no tag', () => {
    expect(parseCategoryTag('a plain name')).toBeUndefined();
    expect(parseCategoryTag('')).toBeUndefined();
    expect(parseCategoryTag('empty [] brackets')).toBeUndefined();
  });
});

describe('partitionCases — agreement partition math', () => {
  it('classifies all-pass / all-fail / split / incomplete', () => {
    const allPass = makeCase(['pass', 'pass', 'pass']);
    const allFail = makeCase(['fail', 'fail', 'fail']);
    const split = makeCase(['pass', 'fail', 'pass']);
    const errored = makeCase(['pass', 'error', 'pass']);
    const missing = makeCase(['pass', 'pass', 'missing']);

    const p = partitionCases([allPass, allFail, split, errored, missing]);
    expect(p.allPass).toEqual([allPass]);
    expect(p.allFail).toEqual([allFail]);
    expect(p.split).toEqual([split]);
    expect(p.incomplete).toEqual([errored, missing]);
  });

  it('reproduces the reference partition shape (59 all-pass / 5 all-fail / 20 split of 84)', () => {
    const cases = [
      ...Array.from({ length: 59 }, () => makeCase(['pass', 'pass', 'pass'])),
      ...Array.from({ length: 5 }, () => makeCase(['fail', 'fail', 'fail'])),
      ...Array.from({ length: 20 }, () => makeCase(['fail', 'pass', 'pass'])),
    ];
    const p = partitionCases(cases);
    expect(cases).toHaveLength(84);
    expect(p.allPass).toHaveLength(59);
    expect(p.allFail).toHaveLength(5);
    expect(p.split).toHaveLength(20);
    expect(p.incomplete).toHaveLength(0);
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(median([NaN, 5])).toBe(5);
  });
});

describe('buildComparisonContext — prefix content', () => {
  it('returns an empty prefix (but a valid partition) when no cases are supplied', () => {
    const ctx = buildComparisonContext(RUNS_3, []);
    expect(ctx.prefixText).toBe('');
    expect(ctx.focusCaseIds).toEqual([]);
  });

  it('states per-run totals and the agreement partition, computed in code', () => {
    const cases = [
      makeCase(['pass', 'pass', 'pass']),
      makeCase(['fail', 'fail', 'fail']),
      makeCase(['pass', 'fail', 'pass']),
      makeCase(['fail', 'pass', 'pass']),
    ];
    const { prefixText } = buildComparisonContext(RUNS_3, cases);
    // Per-run totals: A 2/4, B 2/4, C 3/4.
    expect(prefixText).toContain('A = cc-os-rag (2/4 passed');
    expect(prefixText).toContain('B = pi-os-rag (2/4 passed');
    expect(prefixText).toContain('C = logos-os-rag (3/4 passed');
    // Partition line.
    expect(prefixText).toContain('Agreement across 4 shared cases: 1 all-pass · 1 all-fail · 2 split');
    // Anti-recount instruction for the LLM.
    expect(prefixText).toMatch(/do NOT recount/);
  });

  it('includes median case duration per run when durations are present', () => {
    const cases = [
      makeCase(['pass', 'pass', 'pass'], { durationsMs: [40000, 30000, 50000] }),
      makeCase(['pass', 'pass', 'pass'], { durationsMs: [42000, 34000, 54000] }),
      makeCase(['pass', 'pass', 'pass'], { durationsMs: [44000, 38000, null] }),
    ];
    const { prefixText } = buildComparisonContext(RUNS_3, cases);
    expect(prefixText).toContain('median case duration 42s'); // A
    expect(prefixText).toContain('median case duration 34s'); // B
    expect(prefixText).toContain('median case duration 52s'); // C: median(50000, 54000)
  });

  it('builds a per-category pass-rate table from the name tags', () => {
    const cases = [
      makeCase(['pass', 'pass', 'pass'], { name: 'q1 [basic] one' }),
      makeCase(['fail', 'pass', 'pass'], { name: 'q2 [basic] two' }),
      makeCase(['fail', 'fail', 'fail'], { name: 'q3 [semantic] three' }),
      makeCase(['pass', 'fail', 'pass'], { name: 'q4 [semantic] four' }),
      makeCase(['pass', 'pass', 'pass'], { name: 'q5 no tag five' }),
    ];
    const { prefixText } = buildComparisonContext(RUNS_3, cases);
    expect(prefixText).toContain('Per-category pass rates');
    expect(prefixText).toContain('| category | cases | A | B | C |');
    expect(prefixText).toContain('| basic | 2 | 50% | 100% | 100% |');
    expect(prefixText).toContain('| semantic | 2 | 50% | 0% | 50% |');
    expect(prefixText).toContain('| uncategorized | 1 | 100% | 100% | 100% |');
  });

  it('omits the category table when every case falls in one bucket', () => {
    const cases = [
      makeCase(['pass', 'pass', 'pass'], { name: 'q1 [basic] one' }),
      makeCase(['fail', 'pass', 'pass'], { name: 'q2 [basic] two' }),
    ];
    const { prefixText } = buildComparisonContext(RUNS_3, cases);
    expect(prefixText).not.toContain('Per-category pass rates');
  });
});

describe('buildComparisonContext — information-value sampling', () => {
  it('lists split + all-fail cases with per-run marks, and only ONE all-pass exemplar', () => {
    const split = makeCase(['pass', 'fail', 'pass'], {
      id: 'tc-split-1',
      name: 'qst_0042 [semantic] Which signing credential rotates first',
      durationsMs: [41000, 38000, 52000],
    });
    const allFail = makeCase(['fail', 'fail', 'fail'], { id: 'tc-fail-1' });
    const passes = Array.from({ length: 10 }, () => makeCase(['pass', 'pass', 'pass']));
    const { prefixText, focusCaseIds } = buildComparisonContext(RUNS_3, [split, allFail, ...passes]);

    // Split one-liner: id + marks + durations.
    expect(prefixText).toContain('[tc-split-1]');
    expect(prefixText).toContain('A✓ B✗ C✓');
    expect(prefixText).toContain('(41s/38s/52s)');
    expect(prefixText).toContain('[tc-fail-1]');
    expect(prefixText).toContain('A✗ B✗ C✗');

    // Exactly one all-pass exemplar; the other 9 all-pass cases are dropped.
    expect(prefixText).toContain('All-pass exemplar (representative of the 10 cases every run passed)');
    const allPassIds = passes.map((c) => c.id).filter((id) => prefixText.includes(`[${id}]`));
    expect(allPassIds).toHaveLength(1);

    // Focus cases: split first, then all-fail.
    expect(focusCaseIds).toEqual(['tc-split-1', 'tc-fail-1']);
  });

  it('caps split/all-fail lists and focus cases at the configured maxima', () => {
    const splits = Array.from({ length: 30 }, () => makeCase(['pass', 'fail', 'pass']));
    const fails = Array.from({ length: 12 }, () => makeCase(['fail', 'fail', 'fail']));
    const { prefixText, focusCaseIds } = buildComparisonContext(RUNS_3, [...splits, ...fails]);

    expect(prefixText).toContain(
      `showing ${DEFAULT_CONTEXT_OPTIONS.maxSplitCases} of 30`
    );
    expect(prefixText).toContain(`showing ${DEFAULT_CONTEXT_OPTIONS.maxAllFailCases} of 12`);
    expect(focusCaseIds).toHaveLength(DEFAULT_CONTEXT_OPTIONS.maxFocusCases);
    // All focus cases come from the split partition (higher information value).
    expect(focusCaseIds).toEqual(splits.slice(0, DEFAULT_CONTEXT_OPTIONS.maxFocusCases).map((c) => c.id));
  });

  it('marks errored/missing verdicts distinctly in case lines', () => {
    const c = makeCase(['pass', 'error', 'missing']);
    // error/missing verdicts make the case incomplete → not sampled, but the
    // partition line must count it.
    const { prefixText } = buildComparisonContext(RUNS_3, [c, makeCase(['pass', 'fail', 'pass'])]);
    expect(prefixText).toContain('1 incomplete');
  });
});

describe('buildComparisonContext — budget trimming (drop order)', () => {
  const longName = (i: number) =>
    `qst_${i} [semantic] ${'A very long question name that eats budget '.repeat(3)}${i}`;

  it('drops the exemplar first, then the category table, then all-fail overflow, then split overflow', () => {
    const splits = Array.from({ length: 24 }, (_, i) =>
      makeCase(['pass', 'fail', 'pass'], { name: longName(i) })
    );
    const fails = Array.from({ length: 8 }, (_, i) =>
      makeCase(['fail', 'fail', 'fail'], { name: `qf_${i} [basic] shared failure ${i}` })
    );
    const passes = Array.from({ length: 5 }, () => makeCase(['pass', 'pass', 'pass']));
    const all = [...splits, ...fails, ...passes];

    const full = buildComparisonContext(RUNS_3, all);
    expect(full.prefixText).toContain('All-pass exemplar');
    expect(full.prefixText).toContain('Per-category pass rates');

    // Budget that fits everything except the exemplar + table.
    const noExtras = buildComparisonContext(RUNS_3, all, {
      maxPrefixChars: full.prefixText.length - 200,
    });
    expect(noExtras.prefixText).not.toContain('All-pass exemplar');

    // Tighter: all-fail lines start dropping before split lines.
    const tight = buildComparisonContext(RUNS_3, all, { maxPrefixChars: 3000 });
    expect(tight.prefixText.length).toBeLessThanOrEqual(3000);
    expect(tight.prefixText).not.toContain('All-pass exemplar');
    expect(tight.prefixText).not.toContain('Per-category pass rates');
    const splitShown = (tight.prefixText.match(/qst_/g) || []).length;
    const failShown = (tight.prefixText.match(/qf_/g) || []).length;
    expect(splitShown).toBeGreaterThan(0);
    expect(failShown).toBeLessThan(8);
  });

  it('falls back to header + partition only when even trimmed lists blow the cap', () => {
    const splits = Array.from({ length: 24 }, (_, i) =>
      makeCase(['pass', 'fail', 'pass'], { name: longName(i) })
    );
    const ctx = buildComparisonContext(RUNS_3, splits, { maxPrefixChars: 400 });
    expect(ctx.prefixText).toContain('Agreement across 24 shared cases');
    expect(ctx.prefixText).not.toContain('### Split cases');
    // Focus-case nomination is unaffected by prompt trimming.
    expect(ctx.focusCaseIds).toHaveLength(DEFAULT_CONTEXT_OPTIONS.maxFocusCases);
  });

  it('truncates very long case names in one-liners', () => {
    const c = makeCase(['pass', 'fail', 'pass'], { name: `q [basic] ${'x'.repeat(300)}` });
    const { prefixText } = buildComparisonContext(RUNS_3, [c]);
    const line = prefixText.split('\n').find((l) => l.includes(`[${c.id}]`))!;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('…');
  });
});
