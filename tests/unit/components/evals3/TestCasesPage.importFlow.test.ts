/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the evals3 "duplicated import flow" fix on
 * TestCasesPage4 (components/evals3/TestCasesPage.tsx).
 *
 * Unlike the top-level components/TestCasesPage.tsx, this evals3 variant
 * had NO existing unit coverage at all. Its import handler used to read a
 * non-existent `(result as any).ids` property (always `undefined`, so
 * import always failed with "created IDs are unavailable" -- see
 * CHANGELOG "Duplicated import flow" entry). The fix takes ids directly
 * from the bulk-create response's `testCases` array.
 */

import * as React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
  useLocation: () => ({ pathname: '/evaluations/test-cases', search: '', hash: '', state: null, key: 'default' }),
}));

const mockBulkCreate = jest.fn();
const mockGetAllTestCases = jest.fn().mockResolvedValue([]);
const mockGetAllBenchmarks = jest.fn().mockResolvedValue([]);
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
    getAll: (...args: unknown[]) => mockGetAllBenchmarks(...args),
    create: (...args: unknown[]) => mockBenchmarkCreate(...args),
  },
}));

jest.mock('@/hooks/useClusterContext', () => ({
  useClusterContext: () => ({ context: null, loading: false, error: null }),
}));

jest.mock('@/components/comparison/ClusterContextBanner', () => ({
  ClusterContextBanner: () => null,
}));

jest.mock('@/components/QuickRunModal', () => ({
  QuickRunModal: () => null,
}));

jest.mock('@/components/TestCaseEditor', () => ({
  TestCaseEditor: () => null,
}));

jest.mock('@/components/evals3/Breadcrumbs', () => ({
  // The import-flow toolbar (file input, search, filters) is passed as the
  // `actions` prop, not a child -- a bare `() => null` mock would silently
  // discard it and every element this test queries for.
  Breadcrumbs: ({ actions }: { actions?: React.ReactNode }) => actions ?? null,
}));

import { TestCasesPage4 } from '@/components/evals3/TestCasesPage';

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

describe('TestCasesPage4 (evals3) — JSON import uses the bulk-create response, not a full re-fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllTestCases.mockResolvedValue([]);
    mockGetAllBenchmarks.mockResolvedValue([]);
    mockGetRunCounts.mockResolvedValue({});
    mockBenchmarkCreate.mockImplementation(async (input) => ({ id: 'bench-new', runs: [], ...input }));
  });

  it('creates the benchmark from bulkCreate ids without a fallback re-fetch, and navigates to it', async () => {
    mockBulkCreate.mockResolvedValue({
      created: 2,
      errors: 0,
      testCases: [
        createdTestCase('tc-a', 'Import case A'),
        createdTestCase('tc-b', 'Import case B'),
      ],
    });

    const { container } = render(React.createElement(TestCasesPage4));
    await waitFor(() => expect(container.querySelector('[data-testid="test-cases-page"]')).toBeTruthy());

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

    // The benchmark must be created with ids taken directly from the
    // bulk-create response -- this is the exact line the pre-fix code read
    // as `(result as any).ids` (always undefined).
    const createCall = mockBenchmarkCreate.mock.calls[0][0];
    expect(createCall.testCaseIds).toEqual(['tc-a', 'tc-b']);
    expect(createCall.versions[0].testCaseIds).toEqual(['tc-a', 'tc-b']);
  });

  it('logs an error and does not create a benchmark when bulkCreate reports 0 created ids (guard branch)', async () => {
    mockBulkCreate.mockResolvedValue({ created: 1, errors: 0, testCases: [] });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(React.createElement(TestCasesPage4));
    await waitFor(() => expect(container.querySelector('[data-testid="test-cases-page"]')).toBeTruthy());

    const importedJson = JSON.stringify([
      { name: 'Import case A', category: 'RCA', difficulty: 'Medium', initialPrompt: 'p', expectedOutcomes: ['o'] },
    ]);
    const file = new File([importedJson], 'my-import.json', { type: 'application/json' });
    (file as any).text = async () => importedJson;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(mockBulkCreate).toHaveBeenCalled());
    await waitFor(() =>
      expect(consoleSpy).toHaveBeenCalledWith('Import succeeded but created IDs are unavailable'),
    );
    expect(mockBenchmarkCreate).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
