/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for a data-loss bug uncovered while fixing the
 * full-test-case-payload performance issue (see CHANGELOG "Fixed" entry
 * for this branch).
 *
 * List views (TestCasesPage, EvalsPage, BenchmarksPage, ...) now fetch
 * test cases with `getAll({ summary: true })`, which truncates
 * `initialPrompt` to 200 chars and empties `context` / `expectedOutcomes`
 * / `versions` (see server/routes/storage/testCases.ts `toSummary`).
 *
 * TestCaseEditor previously seeded its form state directly from whatever
 * `testCase` prop it was given. If a caller opened the editor with a
 * summary record (exactly what the list pages now hand it when the user
 * clicks Edit), the form would silently show an empty Context /
 * Expected Outcomes list and a truncated prompt — and clicking Save
 * would persist THAT truncated/empty data, permanently wiping the real
 * content for that test case.
 *
 * The fix: TestCaseEditor always refetches the full record by id
 * (`asyncTestCaseStorage.getById`) when editing an existing test case,
 * and reseeds form state from the full response. This test fails if
 * that refetch is ever removed.
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getLabels: jest.fn().mockResolvedValue([]),
    getById: jest.fn(),
  },
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { TestCaseEditor } from '@/components/TestCaseEditor';

const mockGetById = asyncTestCaseStorage.getById as jest.MockedFunction<typeof asyncTestCaseStorage.getById>;

// A lightweight "summary" record — exactly what list views pass to the
// editor today (see toSummary() server-side): initialPrompt truncated,
// context/expectedOutcomes emptied out.
function summaryTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Diagnose CPU spike',
    description: 'desc',
    labels: ['category:RCA'],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'A'.repeat(200) + '...',
    context: [],
    expectedOutcomes: [],
    ...overrides,
  } as TestCase;
}

// The full record, as returned by GET /api/storage/test-cases/:id
// (no summary transform applied).
function fullTestCase(): TestCase {
  return {
    id: 'tc-1',
    name: 'Diagnose CPU spike',
    description: 'desc',
    labels: ['category:RCA'],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'Full original prompt, much longer than the 200-char summary truncation, describing the CPU spike investigation in detail.',
    context: [{ description: 'runbook', value: 'https://runbooks.example.com/cpu-spike' }],
    expectedOutcomes: ['Identifies the offending process', 'Recommends a scale-up or throttle'],
  } as TestCase;
}

describe('TestCaseEditor — refetches full record when given a summary test case', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  it('calls getById(testCase.id) on mount when editing an existing test case', async () => {
    mockGetById.mockResolvedValue(fullTestCase());

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(mockGetById).toHaveBeenCalledWith('tc-1'));
  });

  it('reseeds the form with the FULL context/expectedOutcomes/prompt, not the summary values', async () => {
    const full = fullTestCase();
    mockGetById.mockResolvedValue(full);

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    // Prompt textarea should show the FULL prompt, not the truncated summary one.
    await waitFor(() => {
      const promptField = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
      expect(promptField.value).toBe(full.initialPrompt);
    });

    // Expected outcomes should show the real outcomes, not an empty placeholder.
    expect(screen.getByDisplayValue('Identifies the offending process')).toBeTruthy();
    expect(screen.getByDisplayValue('Recommends a scale-up or throttle')).toBeTruthy();

    // Context should show the real runbook entry, not be empty.
    expect(screen.getByDisplayValue('runbook')).toBeTruthy();
    expect(screen.getByDisplayValue('https://runbooks.example.com/cpu-spike')).toBeTruthy();
  });

  it('does NOT call getById in create mode (testCase = null)', async () => {
    render(
      React.createElement(TestCaseEditor, {
        testCase: null,
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    // Give any stray effects a tick to run.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('disables Save while the full record is still loading, so stale summary data cannot be persisted', async () => {
    let resolveGetById: (tc: TestCase) => void = () => {};
    mockGetById.mockImplementation(
      () => new Promise(resolve => { resolveGetById = resolve; })
    );

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    resolveGetById(fullTestCase());
    await waitFor(() => expect(saveButton.disabled).toBe(false));
  });

  // Regression guard: a naive implementation clears the loading flag in a
  // blanket `.finally()` regardless of success/failure, which re-enables
  // Save even though the form is still seeded from the (possibly
  // truncated/empty) summary prop -- reintroducing the exact data-loss bug
  // this refetch exists to close, just triggered by a transient network
  // error instead of a missing refetch.
  it('keeps Save disabled and shows a retry-able error when the full-record refetch REJECTS (network failure)', async () => {
    mockGetById.mockRejectedValue(new Error('network down'));

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByText(/Could not load the full test case/i)).toBeTruthy());

    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // Recovers on retry once the backend is reachable again.
    mockGetById.mockResolvedValueOnce(fullTestCase());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(saveButton.disabled).toBe(false));
    expect(screen.queryByText(/Could not load the full test case/i)).toBeFalsy();
  });

  it('keeps Save disabled and shows an error when getById resolves null (e.g. 404 / deleted out from under the editor)', async () => {
    mockGetById.mockResolvedValue(null as unknown as TestCase);

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByText(/Could not load the full test case/i)).toBeTruthy());
    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });
});
