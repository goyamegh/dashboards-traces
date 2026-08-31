/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug:
 * BenchmarkResultsView used to call the bare `asyncTestCaseStorage.getAll()`
 * just to look up name/difficulty/category for the per-use-case breakdown
 * cards — all available from the lightweight summary payload.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { Benchmark, TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
  },
  asyncRunStorage: {
    getReportById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@/components/UseCaseCompareView', () => ({
  UseCaseCompareView: () => null,
}));

jest.mock('@/components/benchmarks/BenchmarkSummaryCharts', () => ({
  BenchmarkSummaryCharts: () => null,
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { BenchmarkResultsView } from '@/components/BenchmarkResultsView';

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

function makeBenchmark(): Benchmark {
  return {
    id: 'bench-1',
    name: 'Bench 1',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2024-01-01T00:00:00Z', testCaseIds: ['tc-1'] }],
    testCaseIds: ['tc-1'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    runs: [
      {
        id: 'run-1',
        createdAt: '2024-01-01T00:00:00Z',
        benchmarkVersion: 1,
        results: {
          'tc-1': { status: 'completed', reportId: 'report-1', accuracy: 1 },
        },
      },
    ],
  } as unknown as Benchmark;
}

describe('BenchmarkResultsView — test-case lookup uses the summary payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests getAll({ summary: true }) on mount, not the full payload', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(
      React.createElement(BenchmarkResultsView, { benchmark: makeBenchmark(), onBack: jest.fn() }),
    );

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });

  it('still renders the use-case name from the summary-shaped record', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase({ name: 'Diagnose CPU spike' })]);

    render(
      React.createElement(BenchmarkResultsView, { benchmark: makeBenchmark(), onBack: jest.fn() }),
    );

    await waitFor(() => {
      expect(screen.getByText('Diagnose CPU spike')).toBeTruthy();
    });
  });
});
