/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for CollapsibleTestCaseDefinition's two provenance branches.
 *
 * Composed from two independently-landed features that both touch this
 * component's non-SDK branch's surrounding scaffolding:
 *  - SDK branch: renders ONLY EvalSourceCodeView (whose header carries the
 *    path/badge/copy) — the old standalone "Source File" row and sha256
 *    line must NOT come back (opensearch-project/agent-health#431).
 *  - JSON branch: leads with the reader-oriented TestCaseDefinition (input,
 *    expected outcomes, context, category/difficulty chips), with the
 *    complete serialized test case behind a "View raw JSON" disclosure
 *    (opensearch-project/agent-health#420).
 *
 * The pre-#420 "JSON branch (unchanged)" tests (always-visible pretty JSON,
 * no disclosure) are gone on purpose — #420 intentionally replaces that
 * behavior. Their copy-button coverage is preserved, adapted to the new
 * disclosure-gated flow (open "View raw JSON" first, then copy).
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CollapsibleTestCaseDefinition } from '@/components/evals3/CollapsibleTestCaseDefinition';
import { TestCase } from '@/types';

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
    expectedOutcomes: ['answer is 4'],
    ...overrides,
  } as TestCase;
}

describe('CollapsibleTestCaseDefinition — SDK branch (no redundant rows)', () => {
  const sdkTc = () => baseTestCase({
    sourceFile: 'dist/wixqa.eval.js',
    sourceFileName: 'wixqa.eval.js',
    sourceLanguage: 'javascript',
    sourceHash: 'f1a4bec9a927935b0000000000000000',
    sourceCode: "test('a', () => {});",
  });

  it('renders EvalSourceCodeView and NOT the old standalone Source File row / sha256 line', () => {
    render(h(CollapsibleTestCaseDefinition, { testCase: sdkTc(), defaultOpen: true }));
    // The eval-source header (with the full path) is the single source row.
    expect(screen.getByTestId('eval-source-code-view')).toBeTruthy();
    expect(screen.getByText('dist/wixqa.eval.js')).toBeTruthy();
    // Removed duplicates must not come back:
    expect(screen.queryByText(/^Source File$/i)).toBeNull();
    expect(screen.queryByText(/sha256:/)).toBeNull();
    // Exactly ONE row shows the path (the eval-source header), not two.
    expect(screen.getAllByText('dist/wixqa.eval.js')).toHaveLength(1);
  });

  it('eval source starts collapsed inside the definition section and expands on toggle', () => {
    render(h(CollapsibleTestCaseDefinition, { testCase: sdkTc(), defaultOpen: true }));
    expect(screen.queryByTestId('eval-source-code-body')).toBeNull();
    fireEvent.click(screen.getByTestId('eval-source-toggle'));
    expect(screen.getByTestId('eval-source-code-body')).toBeTruthy();
  });
});

describe('CollapsibleTestCaseDefinition — JSON branch (readable definition + raw JSON disclosure)', () => {
  const originalClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('returns no card when the run has no test-case definition', () => {
    const { container } = render(h(CollapsibleTestCaseDefinition, { testCase: null }));
    expect(container.firstChild).toBeNull();
  });

  it('toggles the readable definition and mounts raw JSON only after disclosure', () => {
    const tc = baseTestCase({
      labels: ['category:RCA', 'difficulty:Hard', 'checkout'],
      initialPrompt: 'Why are checkout requests failing?',
      expectedOutcomes: [
        'Identify the payment-service timeout',
        'Recommend a safe mitigation',
      ],
      context: [
        { description: 'Cluster evidence', value: '{"service":"payment-service","error":"timeout"}' },
      ],
    });
    render(h(CollapsibleTestCaseDefinition, { testCase: tc }));

    const definitionToggle = screen.getByRole('button', { name: /Test Case Definition/i });
    expect(definitionToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Why are checkout requests failing?')).toBeNull();

    fireEvent.click(definitionToggle);

    expect(definitionToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Why are checkout requests failing?')).toBeTruthy();
    expect(screen.getByText('Identify the payment-service timeout')).toBeTruthy();
    expect(screen.getByText('Recommend a safe mitigation')).toBeTruthy();
    expect(screen.getByText('Cluster evidence')).toBeTruthy();
    expect(screen.getByText('RCA')).toBeTruthy();
    expect(screen.getByText('Hard')).toBeTruthy();
    expect(screen.queryByTestId('raw-test-case-json')).toBeNull();
    // No eval-source view for JSON test cases — that's the SDK branch only.
    expect(screen.queryByTestId('eval-source-code-view')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));

    const raw = screen.getByTestId('raw-test-case-json');
    expect(raw.textContent).toContain('"initialPrompt": "Why are checkout requests failing?"');
    expect(screen.getByRole('button', { name: 'Hide raw JSON' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(definitionToggle);
    expect(definitionToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('raw-test-case-json')).toBeNull();
  });

  it('raw JSON copy button copies the pretty-printed JSON once disclosed', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const tc = baseTestCase();
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));

    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    fireEvent.click(screen.getByTitle(/copy json/i));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(tc, null, 2)));
  });
});

describe('TestCaseDefinition — SDK / code-authored cases', () => {
  const { TestCaseDefinition } = require('@/components/TestCaseDefinition');

  it('renders the source-file pointer instead of an empty declarative rubric', () => {
    const sdkCase = baseTestCase({
      id: 'tc-sdk',
      name: 'sdk registered test',
      initialPrompt: '',
      expectedOutcomes: [],
      sourceFile: 'examples/eval-files/demo.eval.ts',
    });
    render(h(TestCaseDefinition, { testCase: sdkCase }));
    expect(screen.getByText('examples/eval-files/demo.eval.ts')).toBeTruthy();
    expect(screen.getByText(/isn't serializable from runtime state/)).toBeTruthy();
    expect(screen.queryByText(/expected outcomes/i)).toBeNull();
  });

  it('still renders the declarative rubric for JSON cases', () => {
    const tc = baseTestCase({
      initialPrompt: 'Why are checkout requests failing?',
      expectedOutcomes: ['Identify the payment-service timeout'],
    });
    render(h(TestCaseDefinition, { testCase: tc }));
    expect(screen.getByText('Why are checkout requests failing?')).toBeTruthy();
    expect(screen.getByText('Identify the payment-service timeout')).toBeTruthy();
  });
});
