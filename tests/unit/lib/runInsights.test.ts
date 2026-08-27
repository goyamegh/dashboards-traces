/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeCategoryBars,
  clusterFailureThemes,
  formatCappedNote,
  pickTopN,
  normalizeReasoningKey,
} from '@/lib/runInsights';
import { MCP_CONNECTIVITY_FIXTURE } from '../fixtures/mcpConnectivityReasonings';

describe('computeCategoryBars', () => {
  it('tallies passed/failed/errored per category and sorts by total desc, then alpha', () => {
    const rows = [
      { category: 'RAG', status: 'passed' },
      { category: 'RAG', status: 'failed' },
      { category: 'RAG', status: 'failed' },
      { category: 'Tools', status: 'errored' },
      { category: 'Tools', status: 'passed' },
      { category: 'Tools', status: 'passed' },
      { category: 'Tools', status: 'passed' },
    ];
    const bars = computeCategoryBars(rows);
    expect(bars).toEqual([
      { category: 'Tools', passed: 3, failed: 0, errored: 1, total: 4 },
      { category: 'RAG', passed: 1, failed: 2, errored: 0, total: 3 },
    ]);
  });

  it('buckets missing/blank categories under Uncategorized', () => {
    const bars = computeCategoryBars([
      { category: '', status: 'passed' },
      { category: '  ', status: 'failed' },
    ]);
    expect(bars).toEqual([{ category: 'Uncategorized', passed: 1, failed: 1, errored: 0, total: 2 }]);
  });

  it('ties on total break alphabetically', () => {
    const bars = computeCategoryBars([
      { category: 'Zeta', status: 'passed' },
      { category: 'Alpha', status: 'passed' },
    ]);
    expect(bars.map(b => b.category)).toEqual(['Alpha', 'Zeta']);
  });

  it('returns an empty array for no rows', () => {
    expect(computeCategoryBars([])).toEqual([]);
  });
});

describe('normalizeReasoningKey', () => {
  it('lowercases, strips punctuation, and collapses whitespace on the first sentence only', () => {
    const key = normalizeReasoningKey('The Agent FAILED!  Extra sentence should be dropped.');
    expect(key).toBe('the agent failed');
  });

  it('returns empty string for blank input', () => {
    expect(normalizeReasoningKey('')).toBe('');
    expect(normalizeReasoningKey('   ')).toBe('');
  });
});

describe('clusterFailureThemes', () => {
  it('collapses N near-identical MCP-connectivity reasonings into ONE dominant theme (real 418-verify shape)', () => {
    const themes = clusterFailureThemes(
      MCP_CONNECTIVITY_FIXTURE.map(f => ({ testCaseId: f.testCaseId, reasoning: f.reasoning }))
    );

    // Dominant theme: all 57 connectivity paraphrases, regardless of whether
    // the judge said "unable to retrieve" or "failed to retrieve" (the
    // leading words differ, but they share the longer "retrieve ... from
    // the ... OpenSearch/corpus/knowledge base ... connectivity/unavailable"
    // phrasing that the shingle overlap catches).
    expect(themes[0].count).toBe(57);
    expect(themes[0].testCaseIds).toHaveLength(57);
    expect(themes[0].sampleSnippet.toLowerCase()).toContain('opensearch');

    // The 7 "required facts" failures must NOT be swept into the dominant
    // theme — genuinely different failure mode, no shared phrasing.
    const requiredFactsIds = MCP_CONNECTIVITY_FIXTURE
      .filter(f => f.testCaseId.startsWith('tc-required-facts-'))
      .map(f => f.testCaseId);
    expect(themes[0].testCaseIds).not.toEqual(expect.arrayContaining(requiredFactsIds.slice(0, 1)));

    // Total case coverage across all themes must equal the input size.
    const totalClustered = themes.reduce((s, t) => s + t.count, 0);
    expect(totalClustered).toBe(MCP_CONNECTIVITY_FIXTURE.length);

    // Deterministic: rerunning produces byte-identical output.
    const themesAgain = clusterFailureThemes(
      MCP_CONNECTIVITY_FIXTURE.map(f => ({ testCaseId: f.testCaseId, reasoning: f.reasoning }))
    );
    expect(themesAgain).toEqual(themes);
  });

  it('keeps the required-facts failures as a distinct theme (or themes), separate from connectivity', () => {
    const themes = clusterFailureThemes(
      MCP_CONNECTIVITY_FIXTURE.map(f => ({ testCaseId: f.testCaseId, reasoning: f.reasoning }))
    );
    const requiredFactsIds = new Set(
      MCP_CONNECTIVITY_FIXTURE.filter(f => f.testCaseId.startsWith('tc-required-facts-')).map(f => f.testCaseId)
    );
    const themeForRequiredFacts = themes.find(t => t.testCaseIds.some(id => requiredFactsIds.has(id)));
    expect(themeForRequiredFacts).toBeDefined();
    // None of the required-facts ids leaked into a theme that also contains
    // a connectivity-fixture id.
    for (const t of themes) {
      const hasRequired = t.testCaseIds.some(id => requiredFactsIds.has(id));
      const hasConnectivity = t.testCaseIds.some(id => !requiredFactsIds.has(id));
      expect(hasRequired && hasConnectivity).toBe(false);
    }
  });

  it('returns one theme per case when reasonings are unrelated', () => {
    const themes = clusterFailureThemes([
      { testCaseId: 'a', reasoning: 'Completely unrelated failure about date parsing edge cases.' },
      { testCaseId: 'b', reasoning: 'A totally different problem involving currency rounding errors.' },
      { testCaseId: 'c', reasoning: 'Yet another distinct issue regarding timezone offset handling.' },
    ]);
    expect(themes).toHaveLength(3);
    expect(themes.every(t => t.count === 1)).toBe(true);
  });

  it('is order-independent (union-find over shared shingles, not first-seen order)', () => {
    const items = MCP_CONNECTIVITY_FIXTURE.map(f => ({ testCaseId: f.testCaseId, reasoning: f.reasoning }));
    const reversed = [...items].reverse();
    const forward = clusterFailureThemes(items);
    const backward = clusterFailureThemes(reversed);
    expect(forward[0].count).toBe(backward[0].count);
    expect(new Set(forward[0].testCaseIds)).toEqual(new Set(backward[0].testCaseIds));
  });

  it('leaves very short reasonings as their own theme rather than risk over-clustering', () => {
    const themes = clusterFailureThemes([
      { testCaseId: 'a', reasoning: 'Failed.' },
      { testCaseId: 'b', reasoning: 'Error.' },
    ]);
    expect(themes).toHaveLength(2);
  });

  it('returns an empty array for no failing cases', () => {
    expect(clusterFailureThemes([])).toEqual([]);
  });
});

describe('formatCappedNote', () => {
  it('returns null when nothing was capped', () => {
    expect(formatCappedNote(40, 40)).toBeNull();
    expect(formatCappedNote(40, 30)).toBeNull();
  });

  it('formats a "Based on N of M" note when capped', () => {
    expect(formatCappedNote(100, 140)).toBe('Based on 100 of 140 failing cases');
  });
});

describe('pickTopN', () => {
  it('ranks by value descending, drops null/undefined/NaN, and caps at N', () => {
    const ranked = pickTopN(
      [
        { testCaseId: 'a', value: 10 },
        { testCaseId: 'b', value: null },
        { testCaseId: 'c', value: 30 },
        { testCaseId: 'd', value: undefined },
        { testCaseId: 'e', value: 20 },
        { testCaseId: 'f', value: NaN },
      ],
      2
    );
    expect(ranked).toEqual([
      { testCaseId: 'c', value: 30 },
      { testCaseId: 'e', value: 20 },
    ]);
  });

  it('breaks ties by lower testCaseId first', () => {
    const ranked = pickTopN(
      [
        { testCaseId: 'zzz', value: 5 },
        { testCaseId: 'aaa', value: 5 },
      ],
      2
    );
    expect(ranked.map(r => r.testCaseId)).toEqual(['aaa', 'zzz']);
  });
});
