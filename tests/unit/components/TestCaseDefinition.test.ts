/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the composition between opensearch-project/agent-health#420
 * ("Readable test-case definitions in run views", components/TestCaseDefinition.tsx)
 * and this branch's context-value pretty-printing fix
 * (lib/contextFormat.ts + components/evals3/ContextValueView.tsx).
 *
 * TestCaseDefinition.tsx normally ships via #420. It is pre-added on this
 * branch (see the file's own module docstring) purely so a `main-goyamegh`
 * rebuild's merge of #420 + this branch produces a real, rerere-trackable
 * conflict instead of silently dropping the composition. This test locks in
 * the composition itself: context items must render through
 * ContextValueView's pretty-printed/highlighted/collapsible treatment, not
 * a raw truncated/plain `<pre>` block.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TestCaseDefinition } from '@/components/TestCaseDefinition';
import type { TestCase } from '@/types';

jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return React.createElement('div', null, children);
  };
});
jest.mock('remark-gfm', () => () => {});

const h = React.createElement;

function baseTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Test Case',
    description: 'desc',
    labels: [],
    category: 'General',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'What is 2+2?',
    context: [],
    expectedOutcomes: [],
    ...overrides,
  } as TestCase;
}

describe('TestCaseDefinition — context composition with ContextValueView', () => {
  it('renders each context item via ContextValueView (pretty-printed, highlighted, collapsible)', () => {
    const jsonValue = JSON.stringify({ appId: 'explore', timeRange: { from: 'now-15m', to: 'now' } });
    const tc = baseTestCase({
      context: [
        { description: 'Query context', value: jsonValue },
        { description: 'Alert note', value: 'Plain text note, not JSON.' },
      ],
    });

    render(h(TestCaseDefinition, { testCase: tc }));

    // Both item titles render (ContextValueView's toggle-button label).
    expect(screen.getByText('Query context')).toBeTruthy();
    expect(screen.getByText('Alert note')).toBeTruthy();

    // JSON item: pretty-printed + syntax-highlighted via ContextValueView,
    // not the raw one-liner a plain `<pre>{value}</pre>` would show.
    const pretty = screen.getByTestId('context-value-pretty');
    expect(pretty.textContent).not.toBe(jsonValue);
    expect(pretty.textContent).toContain('"appId"');
    expect(pretty.querySelectorAll('.token').length).toBeGreaterThan(0);

    // Non-JSON item: full plain text via ContextValueView's plain path.
    expect(screen.getByTestId('context-value-plain').textContent).toBe('Plain text note, not JSON.');

    // Each item is independently collapsible (ContextValueView's toggle).
    const toggles = screen.getAllByTestId('context-value-toggle');
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);
    expect(screen.queryByTestId('context-value-pretty')).toBeNull();
    // The other item is unaffected.
    expect(screen.getByTestId('context-value-plain')).toBeTruthy();
  });

  it('renders nothing for the context section when there is no context', () => {
    render(h(TestCaseDefinition, { testCase: baseTestCase({ context: [] }) }));
    expect(screen.queryByTestId('context-value-view')).toBeNull();
    expect(screen.queryByText(/^Context \(/)).toBeNull();
  });
});
