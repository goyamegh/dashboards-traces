/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the "duplicated import flow" fix on BenchmarksPage:
 * handleImportFile used to call `bulkCreate()` and then re-fetch the ENTIRE
 * test-case corpus (`getAll()`) just to find the newly created ids by
 * matching on `name` — both a full-payload performance bug AND a
 * correctness bug (name collisions resolve to the wrong id).
 *
 * The server's bulk-create response already returns the created records
 * (server/routes/storage/testCases.ts), so the fix takes ids directly from
 * `bulkCreate()`'s response and never re-fetches the list.
 */

import * as React from 'react';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

const mockBulkCreate = jest.fn();
const mockGetAll = jest.fn().mockResolvedValue([]);
const mockBenchmarkCreate = jest.fn();

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
    bulkCreate: (...args: unknown[]) => mockBulkCreate(...args),
  },
  asyncBenchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    create: (...args: unknown[]) => mockBenchmarkCreate(...args),
  },
}));

jest.mock('@/hooks/useBenchmarkCancellation', () => ({
  useBenchmarkCancellation: () => ({ cancellingRunId: null, handleCancelRun: jest.fn() }),
}));

jest.mock('@/services/client', () => ({
  executeBenchmarkRun: jest.fn(),
}));

jest.mock('@/components/BenchmarkEditor', () => ({
  BenchmarkEditor: () => null,
}));

jest.mock('@/components/BenchmarkResultsView', () => ({
  BenchmarkResultsView: () => null,
}));

import { BenchmarksPage } from '@/components/BenchmarksPage';

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

describe('BenchmarksPage — JSON import uses the bulk-create response, not a full re-fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
    mockBenchmarkCreate.mockImplementation(async (input) => ({ id: 'bench-new', runs: [], ...input }));
  });

  it('creates the benchmark from bulkCreate ids without calling getAll()', async () => {
    mockBulkCreate.mockResolvedValue({
      created: 2,
      errors: 0,
      testCases: [
        createdTestCase('tc-a', 'Import case A'),
        createdTestCase('tc-b', 'Import case B'),
      ],
    });

    render(React.createElement(BenchmarksPage));
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled()); // initial list load
    mockGetAll.mockClear();

    const importedJson = JSON.stringify([
      { name: 'Import case A', category: 'RCA', difficulty: 'Medium', initialPrompt: 'p', expectedOutcomes: ['o'] },
      { name: 'Import case B', category: 'RCA', difficulty: 'Medium', initialPrompt: 'p', expectedOutcomes: ['o'] },
    ]);
    const file = new File([importedJson], 'my-import.json', { type: 'application/json' });
    // jsdom's File doesn't implement Blob#text() in this environment; stub
    // it so the component's `await file.text()` resolves to the JSON body.
    (file as any).text = async () => importedJson;
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(mockBenchmarkCreate).toHaveBeenCalled());

    // The import flow itself must not re-fetch the full test-case corpus.
    expect(mockGetAll).not.toHaveBeenCalled();

    // The benchmark must be created with ids taken directly from the
    // bulk-create response.
    const createCall = mockBenchmarkCreate.mock.calls[0][0];
    expect(createCall.testCaseIds).toEqual(['tc-a', 'tc-b']);
  });
});
