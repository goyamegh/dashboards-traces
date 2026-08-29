/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the top-level components/TestCasesPage.tsx
 * "duplicated import flow" fix. See tests/unit/components/BenchmarksPage.
 * importFlow.test.ts for the analogous BenchmarksPage.tsx coverage --
 * TestCasesPage.tsx had the same bug (bulkCreate() followed by a full
 * getAll() re-fetch to resolve ids by name) but no dedicated test.
 */

import * as React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

const mockBulkCreate = jest.fn();
const mockGetAllTestCases = jest.fn().mockResolvedValue({ testCases: [], total: 0 });
const mockGetRunCounts = jest.fn().mockResolvedValue({});
const mockBenchmarkCreate = jest.fn();

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: (...args: unknown[]) => mockGetAllTestCases(...args),
    bulkCreate: (...args: unknown[]) => mockBulkCreate(...args),
  },
  asyncRunStorage: {
    getRunCountsByTestCase: (...args: unknown[]) => mockGetRunCounts(...args),
  },
  asyncBenchmarkStorage: {
    create: (...args: unknown[]) => mockBenchmarkCreate(...args),
  },
}));

jest.mock('@/components/TestCaseEditor', () => ({
  TestCaseEditor: () => null,
}));

jest.mock('@/components/QuickRunModal', () => ({
  QuickRunModal: () => null,
}));

import { TestCasesPage } from '@/components/TestCasesPage';

function createdTestCase(id: string, name: string): TestCase {
  return {
    id,
    name,
    description: '',
    labels: ['category:RCA'],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'p',
    context: [],
    expectedOutcomes: [],
  } as TestCase;
}

describe('TestCasesPage — JSON import uses the bulk-create response, not a full re-fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllTestCases.mockResolvedValue({ testCases: [], total: 0 });
    mockGetRunCounts.mockResolvedValue({});
    mockBenchmarkCreate.mockImplementation(async (input) => ({ id: 'bench-new', runs: [], ...input }));
  });

  it('creates the benchmark from bulkCreate ids without a fallback re-fetch', async () => {
    mockBulkCreate.mockResolvedValue({
      created: 2,
      errors: 0,
      testCases: [
        createdTestCase('tc-a', 'Import case A'),
        createdTestCase('tc-b', 'Import case B'),
      ],
    });

    const { container } = render(React.createElement(TestCasesPage));
    await waitFor(() => expect(container.querySelector('[data-testid="test-cases-page"]')).toBeTruthy());
    mockGetAllTestCases.mockClear();

    const importedJson = JSON.stringify([
      { name: 'Import case A', category: 'RCA', difficulty: 'Medium', initialPrompt: 'p', expectedOutcomes: ['o'] },
      { name: 'Import case B', category: 'RCA', difficulty: 'Medium', initialPrompt: 'p', expectedOutcomes: ['o'] },
    ]);
    const file = new File([importedJson], 'my-import.json', { type: 'application/json' });
    (file as any).text = async () => importedJson;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(mockBenchmarkCreate).toHaveBeenCalled());

    // The import flow itself must not re-fetch the full/paginated test-case list.
    expect(mockGetAllTestCases).not.toHaveBeenCalled();

    // The benchmark must be created with ids taken directly from the
    // bulk-create response -- the line the pre-fix code derived by
    // re-fetching everything and matching on `name`.
    const createCall = mockBenchmarkCreate.mock.calls[0][0];
    expect(createCall.testCaseIds).toEqual(['tc-a', 'tc-b']);
    expect(createCall.versions[0].testCaseIds).toEqual(['tc-a', 'tc-b']);
  });
});
