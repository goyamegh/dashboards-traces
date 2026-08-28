/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug:
 * ReportsPage used to call the bare `asyncTestCaseStorage.getAll()` just to
 * look up name/description/category for the reports list and header — all
 * available from the lightweight summary payload.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { TestCase } from '@/types';

jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
  Link: ({ children, ...props }: any) => React.createElement('a', props, children),
}));

jest.mock('@/data/testCases', () => ({
  CATEGORIES: ['RCA', 'Alerts'],
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
  },
  asyncRunStorage: {
    getAllReports: jest.fn().mockResolvedValue([]),
    getReportsByTestCase: jest.fn().mockResolvedValue({ reports: [], total: 0 }),
    getReportCount: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('@/services/metrics', () => ({
  fetchBatchMetrics: jest.fn().mockResolvedValue({ metrics: [] }),
  formatCost: jest.fn(() => '$0'),
  formatDuration: jest.fn(() => '0s'),
  formatTokens: jest.fn(() => '0'),
}));

jest.mock('@/components/RunDetailsPanel', () => ({
  RunDetailsPanel: () => null,
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { ReportsPage } from '@/components/ReportsPage';

const mockGetAll = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;

function summaryTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Diagnose CPU spike',
    description: 'Investigates a CPU spike',
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

describe('ReportsPage — test-case lookup uses the summary payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests getAll({ summary: true }) on mount, not the full payload', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(React.createElement(ReportsPage));

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });

  it('still renders the category dropdown with the summary-shaped test case', async () => {
    mockGetAll.mockResolvedValue([summaryTestCase()]);

    render(React.createElement(ReportsPage));

    await waitFor(() => {
      expect(screen.getByText(/All Categories/)).toBeTruthy();
    });
  });
});
