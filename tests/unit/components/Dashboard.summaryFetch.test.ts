/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the full-test-case-payload performance bug: Dashboard
 * used to call the bare `asyncTestCaseStorage.getAll()` and read `.length`
 * just to show a test-case count — pulling the full ~168MB corpus for a
 * single number.
 *
 * The fix requests one summary record with `size: 1` and reads `.total`
 * from the paginated response instead, so the count never requires
 * fetching (or transferring) every test case.
 */

import * as React from 'react';
import { render, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  Link: ({ children, ...props }: any) => React.createElement('a', props, children),
  useNavigate: () => jest.fn(),
}));

jest.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (_key: string, initial: any) => [initial, jest.fn()],
}));

jest.mock('@/hooks/useDataState', () => ({
  useDataState: () => ({
    dataState: { hasStorageConfigured: true, hasData: true },
    isLoading: false,
    error: null,
  }),
}));

jest.mock('@/config/sampleData', () => ({
  isSampleDataActive: () => false,
}));

jest.mock('@/services/metrics', () => ({
  fetchBatchMetrics: jest.fn().mockResolvedValue({ metrics: [] }),
}));

jest.mock('@/components/charts/AgentTrendChart', () => ({
  AgentTrendChart: () => null,
}));

jest.mock('@/components/dashboard/FirstRunExperience', () => ({
  FirstRunExperience: () => null,
}));

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
  },
  asyncRunStorage: {
    getAllReports: jest.fn().mockResolvedValue([]),
  },
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue({ testCases: [], total: 0, after: null, hasMore: false }),
  },
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { Dashboard } from '@/components/Dashboard';

const mockGetAll = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;

describe('Dashboard — test-case count uses a single summary record, not the full corpus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests getAll({ summary: true, size: 1 }) for the test-case count, not the full payload', async () => {
    mockGetAll.mockResolvedValue({ testCases: [], total: 3941, after: null, hasMore: false });

    render(React.createElement(Dashboard));

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ summary: true, size: 1 }),
    );
    // Must NOT be the old bare call that pulled every test case.
    expect(mockGetAll).not.toHaveBeenCalledWith();
  });
});
