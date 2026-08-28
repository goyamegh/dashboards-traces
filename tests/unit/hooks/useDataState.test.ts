/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useDataState } from '@/hooks/useDataState';
import { getConfigStatus } from '@/lib/dataSourceConfig';

jest.mock('@/lib/dataSourceConfig', () => ({ getConfigStatus: jest.fn() }));

const mockGetConfigStatus = getConfigStatus as jest.MockedFunction<typeof getConfigStatus>;
const mockFetch = jest.fn();

describe('useDataState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
  });

  it('preserves the configured-cluster gate without fetching data', async () => {
    mockGetConfigStatus.mockResolvedValue({
      storage: { configured: true, source: 'environment' },
      observability: { configured: false, source: 'none' },
      runtime: { storage: { backend: 'opensearch', error: null, configuredEndpoint: 'http://cluster', drifted: false } },
    });

    const { result } = renderHook(() => useDataState());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.dataState).toEqual({ hasStorageConfigured: true, hasData: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows the dashboard for file mode when a benchmark has runs', async () => {
    mockGetConfigStatus.mockResolvedValue({
      storage: { configured: false, source: 'none' },
      observability: { configured: false, source: 'none' },
      runtime: { storage: { backend: 'file', error: null, configuredEndpoint: null, drifted: false } },
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ benchmarks: [{ runs: [{ id: 'run-1' }] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ evaluationRuns: [], total: 0 }) });

    const { result } = renderHook(() => useDataState());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.dataState).toEqual({ hasStorageConfigured: false, hasData: true });
  });

  it('keeps onboarding for genuinely empty file storage', async () => {
    mockGetConfigStatus.mockResolvedValue({
      storage: { configured: false, source: 'none' },
      observability: { configured: false, source: 'none' },
      runtime: { storage: { backend: 'file', error: null, configuredEndpoint: null, drifted: false } },
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ benchmarks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ evaluationRuns: [], total: 0 }) });

    const { result } = renderHook(() => useDataState());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.dataState.hasData).toBe(false);
  });
});
