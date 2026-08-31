/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug: EvalsPage
 * used to call the bare `asyncTestCaseStorage.getAll()`, pulling the full
 * ~168MB test-case corpus (every version, full initialPrompt, context,
 * expectedOutcomes) just to render list cards that only ever show
 * id/name/category/difficulty/isPromoted/a short prompt preview.
 *
 * This asserts the list-load path requests the lightweight summary payload
 * (`getAll({ summary: true })`) and still renders correctly from it, so a
 * future edit can't silently regress back to the full fetch.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { TestCase } from '@/types';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    getCategories: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    setPromoted: jest.fn(),
  },
  asyncRunStorage: {
    getReportsByTestCase: jest.fn().mockResolvedValue({ total: 0, reports: [] }),
  },
}));

// Avoid mounting the (heavier) editor/quick-run modals — they're gated
// behind isEditorOpen/isQuickRunOpen, which this test never flips.
jest.mock('@/components/TestCaseEditor', () => ({
  TestCaseEditor: () => null,
}));
jest.mock('@/components/QuickRunModal', () => ({
  QuickRunModal: () => null,
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { EvalsPage } from '@/components/EvalsPage';

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
    initialPrompt: 'Truncated prompt preview...',
    context: [],
    expectedOutcomes: [],
    ...overrides,
  } as TestCase;
}

describe('EvalsPage — list load uses the summary payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (asyncTestCaseStorage.getCategories as jest.Mock).mockResolvedValue(['RCA']);
  });

  it('requests getAll({ summary: true }) on mount, not the full payload', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(React.createElement(EvalsPage));

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    // Must NOT be the old bare call.
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });

  it('still renders the list correctly from summary-shaped records', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase({ name: 'Diagnose CPU spike' })]);

    render(React.createElement(EvalsPage));

    await waitFor(() => {
      expect(screen.getByText('Diagnose CPU spike')).toBeTruthy();
    });
    expect(screen.getByText('1 test case')).toBeTruthy();
  });
});
