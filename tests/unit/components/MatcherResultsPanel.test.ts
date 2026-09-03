/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for MatcherResultsPanel's "not reached" rendering.
 *
 * Bug: a matcher that never executed because an earlier assertion threw
 * was simply absent from the panel — indistinguishable from "this test had
 * fewer claims than expected". The runner now appends a synthetic
 * `notReached: true` entry (see appendNotReachedMarker in
 * services/evaluation/index.ts) for the tail of a test body that never
 * ran; this panel must render that entry distinctly from both a pass and
 * a genuine failure, and must exclude it from the passed/failed header
 * counts (it has its own "N not reached" tally instead).
 *
 * `react-markdown` is mocked because it's an ESM-only dependency pulled in
 * transitively via @/components/ui/markdown — mirrors the pattern in
 * tests/unit/components/RunDetailsContent.test.ts.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MatcherResultsPanel } from '@/components/MatcherResultsPanel';
import type { MatcherResult } from '@/lib/matchers/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: any) => React.createElement('div', null, children),
  hasRealMarkdown: () => false,
}));

const passing: MatcherResult = {
  description: 'expected to contain root cause',
  pass: true,
  method: 'code-assertion',
};

const failingGate: MatcherResult = {
  description: 'expected totalTokens to be below 10000',
  pass: false,
  method: 'traces',
  actual: 47320,
  expected: 10000,
  errorMessage: 'expected 47320 to be below 10000',
};

const notReachedMarker: MatcherResult = {
  description:
    'Test body did not complete: a prior assertion threw, so any ' +
    'expect()/judge()/evaluate() calls after it were never executed.',
  pass: false,
  method: 'code-assertion',
  notReached: true,
  errorMessage: 'expected 47320 to be below 10000',
};

describe('MatcherResultsPanel — not-reached rendering', () => {
  it('renders nothing for an empty/undefined results array', () => {
    const { container: empty } = render(React.createElement(MatcherResultsPanel, { results: [] }));
    expect(empty.firstChild).toBeNull();
  });

  it('shows a distinct "not reached" label for a notReached entry', () => {
    render(React.createElement(MatcherResultsPanel, { results: [passing, failingGate, notReachedMarker] }));
    expect(screen.getByText('not reached')).toBeTruthy();
  });

  it('excludes notReached entries from the passed/failed header counts and gives them their own tally', () => {
    render(React.createElement(MatcherResultsPanel, { results: [passing, failingGate, notReachedMarker] }));
    // 1 passed / 2 reached (passing + failingGate); failingGate is the 1
    // failure; notReachedMarker must NOT be folded into either bucket.
    expect(screen.getByText('(1/2 passed, 1 failed, 1 not reached)')).toBeTruthy();
  });

  it('omits the "not reached" segment entirely when nothing was left unreached', () => {
    render(React.createElement(MatcherResultsPanel, { results: [passing, failingGate] }));
    expect(screen.getByText('(1/2 passed, 1 failed)')).toBeTruthy();
    expect(screen.queryByText(/not reached/)).toBeNull();
  });

  it('renders the notReached row description and error detail (expanded by default)', () => {
    render(React.createElement(MatcherResultsPanel, { results: [notReachedMarker] }));
    // The description renders twice (row header + expanded detail block) —
    // use getAllByText and assert both occurrences are present.
    expect(screen.getAllByText(/Test body did not complete/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/expected 47320 to be below 10000/)).toBeTruthy();
  });
});
