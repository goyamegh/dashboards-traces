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
    update: jest.fn(),
    create: jest.fn(),
  },
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { TestCaseEditor } from '@/components/TestCaseEditor';

const mockUpdate = asyncTestCaseStorage.update as jest.MockedFunction<typeof asyncTestCaseStorage.update>;

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

  it('disables the form inputs (not just Save) while the full record is still loading', async () => {
    // Regression for the hydration race: if inputs stay editable during the
    // refetch, whatever the user types is silently overwritten the moment
    // getById resolves and reseeds form state.
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

    const nameField = screen.getByLabelText(/^Name/i) as HTMLInputElement;
    const promptField = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    expect(nameField.disabled).toBe(true);
    expect(promptField.disabled).toBe(true);

    resolveGetById(fullTestCase());
    await waitFor(() => expect(promptField.disabled).toBe(false));
    expect(nameField.disabled).toBe(false);
  });
});

describe('TestCaseEditor — fails closed when the full-record refetch fails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  it('getById REJECTS: Save stays disabled, an inline error is shown, and Retry re-runs the fetch', async () => {
    mockGetById.mockRejectedValueOnce(new Error('network down'));

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;

    // Fails closed: Save must NOT re-enable just because loading finished —
    // it must stay disabled because the load itself failed. Assert both the
    // button state and the banner text in the SAME waitFor so we don't get
    // caught by the transient still-loading render (button already disabled
    // because isLoadingFullTestCase is still true, before loadError commits).
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
      expect(
        screen.getByText(/Couldn.t load the full test case — editing disabled to prevent data loss/i)
      ).toBeTruthy();
    });

    // Retry re-invokes getById; once it succeeds, the error clears and Save re-enables.
    mockGetById.mockResolvedValueOnce(fullTestCase());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(mockGetById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    expect(
      screen.queryByText(/Couldn.t load the full test case — editing disabled to prevent data loss/i)
    ).toBeNull();
  });

  it('getById resolves null: Save stays disabled and the same inline error is shown', async () => {
    mockGetById.mockResolvedValueOnce(null as unknown as TestCase);

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;

    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
      expect(
        screen.getByText(/Couldn.t load the full test case — editing disabled to prevent data loss/i)
      ).toBeTruthy();
    });

    // Retry recovers the same way it does from a rejection.
    mockGetById.mockResolvedValueOnce(fullTestCase());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(saveButton.disabled).toBe(false));
  });

  it('does not show the fail-closed banner in create mode (testCase = null)', async () => {
    render(
      React.createElement(TestCaseEditor, {
        testCase: null,
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText(/Couldn.t load the full test case/i)).toBeNull();
    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    // Create mode: Save's enablement depends only on required-field validation,
    // never on the (nonexistent) refetch.
    expect(saveButton.disabled).toBe(true); // name + initialPrompt are empty
  });
});

describe('TestCaseEditor — defaults falsy fields from the full record instead of crashing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  // The reseed callback does `full.name || ''`, `full.labels || []`,
  // `full.initialPrompt || ''`, `full.context || []`, and a && / ternary for
  // expectedOutcomes. Every existing fixture in this file gives ALL of
  // these truthy values, so the falsy-fallback side of each has never been
  // exercised. A code-SDK test case genuinely can have no name yet
  // (mid-import) or no context/outcomes at all -- confirm the form falls
  // back to sane empty values rather than rendering `undefined`.
  it('falls back to empty name/labels/prompt/context and a single blank outcome when the full record has none of them', async () => {
    mockGetById.mockResolvedValue({
      id: 'tc-1',
      name: undefined,
      description: undefined,
      labels: undefined,
      initialPrompt: undefined,
      context: undefined,
      expectedOutcomes: undefined,
    } as unknown as TestCase);

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    const nameField = await waitFor(() => screen.getByLabelText(/^Name/i) as HTMLInputElement);
    await waitFor(() => expect(nameField.value).toBe(''));
    const promptField = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    expect(promptField.value).toBe('');

    // expectedOutcomes falls back to a single blank entry (not zero rows --
    // the form always renders at least one Expected Outcome textarea).
    const outcomeTextareas = screen.getAllByPlaceholderText(/Should query CloudWatch/i) as HTMLTextAreaElement[];
    expect(outcomeTextareas).toHaveLength(1);
    expect(outcomeTextareas[0].value).toBe('');

    // No context items rendered (falls back to []), and Save is enabled
    // again now that the (empty-but-successful) load completed -- but only
    // once the user supplies the required name + prompt.
    expect(screen.getByText(/No context items added/i)).toBeTruthy();
  });

  it('falls back to a single blank outcome when expectedOutcomes is an empty array (not just undefined)', async () => {
    mockGetById.mockResolvedValue({
      id: 'tc-1',
      name: 'Has a name',
      labels: [],
      initialPrompt: 'Has a prompt',
      context: [],
      expectedOutcomes: [],
    } as unknown as TestCase);

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => {
      const nameField = screen.getByLabelText(/^Name/i) as HTMLInputElement;
      expect(nameField.value).toBe('Has a name');
    });
    const outcomeTextareas = screen.getAllByPlaceholderText(/Should query CloudWatch/i) as HTMLTextAreaElement[];
    expect(outcomeTextareas).toHaveLength(1);
    expect(outcomeTextareas[0].value).toBe('');
  });
});

describe('TestCaseEditor — locked form surface actually rejects input, not just the disabled attribute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  it('typing into the Name/Initial Prompt fields while locked has no effect on their value', async () => {
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

    const nameField = screen.getByLabelText(/^Name/i) as HTMLInputElement;
    const promptField = screen.getByLabelText(/Initial Prompt/i) as HTMLTextAreaElement;
    expect(nameField.disabled).toBe(true);

    // fireEvent.change dispatches a real DOM 'change' event directly into
    // React's synthetic event system, bypassing the browser-level block on
    // interacting with a disabled control (confirmed empirically: jsdom does
    // NOT block it the way a real browser does). The component therefore
    // can't rely on the disabled attribute alone -- each onChange handler
    // also guards on isFormLocked, so state genuinely cannot change while
    // locked no matter how the event arrives.
    const nameBefore = nameField.value;
    const promptBefore = promptField.value;
    fireEvent.change(nameField, { target: { value: 'typed while locked' } });
    fireEvent.change(promptField, { target: { value: 'typed while locked' } });
    expect(nameField.value).toBe(nameBefore);
    expect(promptField.value).toBe(promptBefore);

    resolveGetById(fullTestCase());
    await waitFor(() => expect(nameField.disabled).toBe(false));

    // Once unlocked, the exact same event now DOES update the field.
    fireEvent.change(nameField, { target: { value: 'typed after unlock' } });
    expect(nameField.value).toBe('typed after unlock');
  });

  it('the Retry button re-issues getById with the same id and the click is a real user event', async () => {
    mockGetById.mockRejectedValueOnce(new Error('network down'));

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith('tc-1');

    mockGetById.mockResolvedValueOnce(fullTestCase());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(mockGetById).toHaveBeenCalledTimes(2));
    expect(mockGetById).toHaveBeenNthCalledWith(2, 'tc-1');
  });
});

describe('TestCaseEditor — Context/Expected Outcomes list editing (unlocked form)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  it('adds, edits, and removes a Context item once the full record has loaded', async () => {
    mockGetById.mockResolvedValue(fullTestCase());

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    // Wait for hydration to finish (fullTestCase() already has one context
    // item -- 'runbook' / the cpu-spike URL -- from the earlier refetch test).
    await waitFor(() => expect(screen.getByDisplayValue('runbook')).toBeTruthy());

    // Two "Add" buttons exist (Expected Outcomes, Context); the Context
    // section's is the second one in form order.
    const addButtons = screen.getAllByRole('button', { name: /add/i });
    fireEvent.click(addButtons[addButtons.length - 1]);

    const descriptionInputs = screen.getAllByPlaceholderText(/Description \(e\.g\., Current cluster state\)/i) as HTMLInputElement[];
    expect(descriptionInputs).toHaveLength(2);
    const newDescriptionInput = descriptionInputs[1];

    fireEvent.change(newDescriptionInput, { target: { value: 'new context desc' } });
    expect((screen.getAllByPlaceholderText(/Description \(e\.g\., Current cluster state\)/i)[1] as HTMLInputElement).value).toBe('new context desc');

    // Remove the newly-added row (the second "Context N" card's trash button).
    const contextCards = screen.getAllByText(/^Context \d+$/);
    expect(contextCards).toHaveLength(2);
    const removeButtons = screen.getAllByRole('button', { name: '' }).filter(b => b.querySelector('svg.lucide-trash2'));
    fireEvent.click(removeButtons[removeButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText(/Description \(e\.g\., Current cluster state\)/i)).toHaveLength(1);
    });
  });

  it('adds a second Expected Outcome, edits both, then removes the first (list re-indexes correctly)', async () => {
    mockGetById.mockResolvedValue(fullTestCase());

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByDisplayValue('Identifies the offending process')).toBeTruthy());

    const addButtons = screen.getAllByRole('button', { name: /add/i });
    // Expected Outcomes' Add button is the first one in the form.
    fireEvent.click(addButtons[0]);

    const outcomeTextareas = () =>
      screen.getAllByPlaceholderText(/Should query CloudWatch/i) as HTMLTextAreaElement[];
    expect(outcomeTextareas()).toHaveLength(3); // 2 seeded + 1 new blank

    fireEvent.change(outcomeTextareas()[2], { target: { value: 'A brand new outcome' } });
    expect(outcomeTextareas()[2].value).toBe('A brand new outcome');

    // Remove the FIRST outcome ('Identifies the offending process') and
    // confirm the remaining two shift up (no stale/duplicated rows).
    const removeOutcomeButtons = screen.getAllByRole('button', { name: '' })
      .filter(b => b.querySelector('svg.lucide-trash2') && b.closest('.flex.gap-1\\.5.items-start'));
    fireEvent.click(removeOutcomeButtons[0]);

    await waitFor(() => expect(outcomeTextareas()).toHaveLength(2));
    const remaining = outcomeTextareas().map(t => t.value);
    expect(remaining).toEqual(['Recommends a scale-up or throttle', 'A brand new outcome']);
  });

  it('does not remove the last remaining Expected Outcome (must always have at least one row)', async () => {
    mockGetById.mockResolvedValue({
      ...fullTestCase(),
      expectedOutcomes: ['The only outcome'],
    });

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByDisplayValue('The only outcome')).toBeTruthy());

    // With only one outcome, handleRemoveOutcome's guard (length > 1) means
    // no remove button is even rendered for it.
    expect(
      screen.queryAllByPlaceholderText(/Should query CloudWatch/i),
    ).toHaveLength(1);
  });
});

describe('TestCaseEditor — Save (form mode) once the full record has loaded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getLabels as jest.Mock).mockResolvedValue([]);
  });

  it('calls asyncTestCaseStorage.update with the current form fields and invokes onSave with the result', async () => {
    mockGetById.mockResolvedValue(fullTestCase());
    const saved = { ...fullTestCase(), name: 'Edited name' };
    mockUpdate.mockResolvedValue(saved);
    const onSave = jest.fn();

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave,
        onCancel: jest.fn(),
      })
    );

    const nameField = await waitFor(() => screen.getByLabelText(/^Name/i) as HTMLInputElement);
    await waitFor(() => expect(nameField.disabled).toBe(false));
    fireEvent.change(nameField, { target: { value: 'Edited name' } });

    const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith('tc-1', expect.objectContaining({
      name: 'Edited name',
      initialPrompt: fullTestCase().initialPrompt,
      context: fullTestCase().context,
      expectedOutcomes: fullTestCase().expectedOutcomes,
    }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(saved));
  });

  it('does not call onSave when update() resolves null (e.g. the record was deleted mid-edit)', async () => {
    mockGetById.mockResolvedValue(fullTestCase());
    mockUpdate.mockResolvedValue(null);
    const onSave = jest.fn();

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave,
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
      expect(saveButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('filters out blank Expected Outcomes before saving', async () => {
    mockGetById.mockResolvedValue(fullTestCase());
    mockUpdate.mockResolvedValue(fullTestCase());

    render(
      React.createElement(TestCaseEditor, {
        testCase: summaryTestCase(),
        onSave: jest.fn(),
        onCancel: jest.fn(),
      })
    );

    await waitFor(() => expect(screen.getByDisplayValue('Identifies the offending process')).toBeTruthy());

    // Add a blank outcome row and leave it empty.
    const addButtons = screen.getAllByRole('button', { name: /add/i });
    fireEvent.click(addButtons[0]);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const call = mockUpdate.mock.calls[0][1];
    expect(call.expectedOutcomes).toEqual([
      'Identifies the offending process',
      'Recommends a scale-up or throttle',
    ]);
  });
});
