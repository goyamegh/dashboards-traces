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
 * Regression guards for the redundant-rows cleanup (owner feedback):
 *  - SDK branch: renders ONLY EvalSourceCodeView (whose header carries the
 *    path/badge/copy) — the old standalone "Source File" row and sha256
 *    line must NOT come back.
 *  - JSON branch: still renders the full untruncated pretty-printed JSON
 *    with a working copy button (unchanged behavior, but the copy handler
 *    was simplified to JSON-only so lock it in).
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CollapsibleTestCaseDefinition } from '@/components/evals3/CollapsibleTestCaseDefinition';
import type { TestCase } from '@/types';

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

function openSection() {
  fireEvent.click(screen.getByRole('button', { name: /test case definition/i }));
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

describe('CollapsibleTestCaseDefinition — JSON branch (unchanged)', () => {
  const originalClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('renders the full untruncated pretty-printed JSON for a non-SDK test case', () => {
    const tc = baseTestCase(); // no sourceFile
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));
    expect(screen.getByText(/Full Definition \(JSON\)/i)).toBeTruthy();
    // Whole object present, including nested fields.
    expect(screen.getByText(/"initialPrompt": "What is 2\+2\?"/)).toBeTruthy();
    expect(screen.getByText(/"expectedOutcomes"/)).toBeTruthy();
    // No eval-source view for JSON test cases.
    expect(screen.queryByTestId('eval-source-code-view')).toBeNull();
  });

  it('copy button copies the pretty-printed JSON', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const tc = baseTestCase();
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));

    await act(async () => {
      fireEvent.click(screen.getByTitle(/copy json/i));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(tc, null, 2));
  });

  it('section itself defaults closed and opens on header click', () => {
    const tc = baseTestCase();
    render(h(CollapsibleTestCaseDefinition, { testCase: tc }));
    expect(screen.queryByText(/Full Definition \(JSON\)/i)).toBeNull();
    openSection();
    expect(screen.getByText(/Full Definition \(JSON\)/i)).toBeTruthy();
  });
});
