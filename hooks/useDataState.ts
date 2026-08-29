/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { getConfigStatus } from '@/lib/dataSourceConfig';

export type OverviewState = 'onboarding' | 'ready-to-run' | 'dashboard';

export interface DataState {
  hasStorageConfigured: boolean;
  /** Whether completed run data exists and the full dashboard can render. */
  hasData: boolean;
  /** Explicit three-way Overview gate; definitions alone are ready, not empty. */
  overviewState: OverviewState;
}

interface UseDataStateReturn {
  dataState: DataState;
  isLoading: boolean;
  error: string | null;
}

/**
 * Detect whether the standard dashboard has anything to display.
 *
 * OpenSearch retains the existing configured-cluster gate. File mode has no
 * cluster by design, so it distinguishes completed runs from imported
 * benchmark/test-case definitions. Only a genuinely empty workspace gets
 * onboarding; definitions without runs get a focused ready-to-run state.
 */
export function useDataState(): UseDataStateReturn {
  const [dataState, setDataState] = useState<DataState>({
    hasStorageConfigured: false,
    hasData: false,
    overviewState: 'onboarding',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkDataState = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Check if storage cluster is configured
        const configStatus = await getConfigStatus();
        const hasStorageConfigured = configStatus.storage.configured;
        let hasData = hasStorageConfigured;
        let overviewState: OverviewState = hasStorageConfigured ? 'dashboard' : 'onboarding';

        if (configStatus.runtime?.storage.backend === 'file') {
          const [benchmarksResponse, testCasesResponse, runsResponse] = await Promise.all([
            fetch('/api/storage/benchmarks?includeSample=false'),
            fetch('/api/storage/test-cases?size=1&includeSample=false'),
            fetch('/api/storage/evaluation-runs?status=completed&size=1'),
          ]);
          if (!benchmarksResponse.ok || !testCasesResponse.ok || !runsResponse.ok) {
            throw new Error('Failed to inspect file storage data');
          }
          const benchmarksPayload = await benchmarksResponse.json();
          const testCasesPayload = await testCasesResponse.json();
          const runsPayload = await runsResponse.json();
          const benchmarks = benchmarksPayload.benchmarks || [];
          const hasBenchmarkRuns = benchmarks
            .some((benchmark: { runs?: unknown[] }) => (benchmark.runs?.length || 0) > 0);
          hasData = hasBenchmarkRuns || (runsPayload.total || 0) > 0;
          const hasDefinitions = benchmarks.length > 0 || (testCasesPayload.total || 0) > 0;
          overviewState = hasData ? 'dashboard' : hasDefinitions ? 'ready-to-run' : 'onboarding';
        }

        setDataState({ hasStorageConfigured, hasData, overviewState });
      } catch (err) {
        // On error, default to unconfigured state (show FirstRunExperience)
        // This is a fail-safe: better to show onboarding than a broken dashboard
        console.error('[useDataState] Failed to load config status:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setDataState({
          hasStorageConfigured: false,
          hasData: false,
          overviewState: 'onboarding',
        });
      } finally {
        setIsLoading(false);
      }
    };

    checkDataState();
  }, []);

  return { dataState, isLoading, error };
}
