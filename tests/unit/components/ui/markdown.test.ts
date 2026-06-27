/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for markdown rendering papercut fixes.
 *
 * 1. hasRealMarkdown (pure logic from @/lib/markdown) — the heuristic that
 *    decides whether agent/judge/tool text renders as markdown or plain text.
 * 2. Source guards that the three surfaces the user reported as "markdown not
 *    rendering" (assistant trajectory, tool results, judge reasoning) actually
 *    route their text through the shared <Markdown> component now.
 *
 * The React render of react-markdown itself isn't exercised here — it's
 * ESM-only and not transformed under Jest's CJS loader (existing tests mock
 * it); the library's own conversion is already tested upstream.
 */

import * as fs from 'fs';
import * as path from 'path';
import { hasRealMarkdown } from '@/lib/markdown';

describe('hasRealMarkdown', () => {
  it('detects bold, headings, code, links, lists, quotes', () => {
    expect(hasRealMarkdown('this is **bold**')).toBe(true);
    expect(hasRealMarkdown('## heading')).toBe(true);
    expect(hasRealMarkdown('inline `code`')).toBe(true);
    expect(hasRealMarkdown('```\nfenced\n```')).toBe(true);
    expect(hasRealMarkdown('[link](https://x.y)')).toBe(true);
    expect(hasRealMarkdown('- a\n- b')).toBe(true);
    expect(hasRealMarkdown('1. a\n2. b')).toBe(true);
    expect(hasRealMarkdown('> quote')).toBe(true);
  });

  it('treats plain prose / single numbered sentence as NOT markdown', () => {
    expect(hasRealMarkdown('')).toBe(false);
    expect(hasRealMarkdown('Just a normal sentence with no markup.')).toBe(false);
    expect(hasRealMarkdown("1. 'Identify root cause' - Fully achieved.")).toBe(false);
  });
});

describe('surfaces route text through the shared <Markdown>', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf-8');

  it('TrajectoryView renders assistant content via <Markdown>, not raw text', () => {
    const src = read('components/TrajectoryView.tsx');
    expect(src).toContain("from '@/components/ui/markdown'");
    expect(src).toContain('<Markdown');
    // The old plain-text expanded branch (bare `step.content`) is gone.
    expect(src).not.toMatch(/\) : \(\s*step\.content\s*\)}/);
  });

  it('MatcherResultsPanel renders judge reasoning via <Markdown>', () => {
    const src = read('components/MatcherResultsPanel.tsx');
    expect(src).toContain("from '@/components/ui/markdown'");
    expect(src).toContain('<Markdown');
    // No longer defines its own copy of the heuristic.
    expect(src).not.toMatch(/function hasRealMarkdown/);
  });
});
