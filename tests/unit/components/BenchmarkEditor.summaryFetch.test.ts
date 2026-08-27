/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug:
 * BenchmarkEditor used to call the bare `asyncTestCaseStorage.getAll()` to
 * populate the "select test cases" step, which only ever renders
 * id/name/category/subcategory/difficulty checkboxes — all preserved by the
 * lightweight summary payload.
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
  },
  asyncBenchmarkStorage: {
    generateRunId: jest.fn(() => 'run-mock-1'),
  },
}));

jest.mock('@/components/JudgeModelSelect', () => ({
  JudgeModelSelect: () => null,
}));

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ evaluators: [] }),
}) as unknown as typeof fetch;

import { asyncTestCaseStorage } from '@/services/storage';
import { BenchmarkEditor } from '@/components/BenchmarkEditor';

const mockGetAll = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;

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
    initialPrompt: 'Truncated...',
    context: [],
    expectedOutcomes: [],
    ...overrides,
  } as TestCase;
}

describe('BenchmarkEditor — test-case picker uses the summary payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ evaluators: [] }) });
  });

  it('requests getAll({ summary: true }) on mount, not the full payload', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(
      React.createElement(BenchmarkEditor, { benchmark: null, onSave: jest.fn(), onCancel: jest.fn() }),
    );

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });

  it('still renders the test-case name/category picker from summary-shaped records', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase({ name: 'Diagnose CPU spike' })]);

    render(
      React.createElement(BenchmarkEditor, { benchmark: null, onSave: jest.fn(), onCancel: jest.fn() }),
    );

    // Fill in the required benchmark name, then advance to the "Select
    // Test Cases" step.
    const nameInput = screen.getByLabelText(/Benchmark Name/i);
    fireEvent.change(nameInput, { target: { value: 'My Benchmark' } });
    const nextButton = await screen.findByText(/Next: Select Test Cases/i);
    nextButton.closest('button')?.click();

    await waitFor(() => {
      expect(screen.getByText('Diagnose CPU spike')).toBeTruthy();
    });
  });
});
