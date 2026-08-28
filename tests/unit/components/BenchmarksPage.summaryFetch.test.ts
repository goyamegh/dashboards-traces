/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug:
 * BenchmarksPage used to call the bare `asyncTestCaseStorage.getAll()` just
 * to look up test-case names for status labels — available from the
 * lightweight summary payload.
 */

import * as React from 'react';
import { render, waitFor } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
  },
  asyncBenchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
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

import { asyncTestCaseStorage } from '@/services/storage';
import { BenchmarksPage } from '@/components/BenchmarksPage';

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

describe('BenchmarksPage — test-case lookup uses the summary payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests getAll({ summary: true }) on mount, not the full payload', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(React.createElement(BenchmarksPage));

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });
});
