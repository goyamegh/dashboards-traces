/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { getConfigStatus } from '@/lib/dataSourceConfig';

export interface DataState {
  hasStorageConfigured: boolean;
  hasData: boolean; // Cluster configured, or persisted data exists in file mode
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
 * cluster by design, so it checks for a benchmark with embedded runs or any
 * completed evaluation run and keeps onboarding only for a genuinely empty
 * workspace.
 */
export function useDataState(): UseDataStateReturn {
  const [dataState, setDataState] = useState<DataState>({
    hasStorageConfigured: false,
    hasData: false,
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

        if (configStatus.runtime?.storage.backend === 'file') {
          const [benchmarksResponse, runsResponse] = await Promise.all([
            fetch('/api/storage/benchmarks?includeSample=false'),
            fetch('/api/storage/evaluation-runs?status=completed&size=1'),
          ]);
          if (!benchmarksResponse.ok || !runsResponse.ok) {
            throw new Error('Failed to inspect file storage data');
          }
          const benchmarksPayload = await benchmarksResponse.json();
          const runsPayload = await runsResponse.json();
          const hasBenchmarkRuns = (benchmarksPayload.benchmarks || [])
            .some((benchmark: { runs?: unknown[] }) => (benchmark.runs?.length || 0) > 0);
          hasData = hasBenchmarkRuns || (runsPayload.total || 0) > 0;
        }

        setDataState({ hasStorageConfigured, hasData });
      } catch (err) {
        // On error, default to unconfigured state (show FirstRunExperience)
        // This is a fail-safe: better to show onboarding than a broken dashboard
        console.error('[useDataState] Failed to load config status:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setDataState({
          hasStorageConfigured: false,
          hasData: false,
        });
      } finally {
        setIsLoading(false);
      }
    };

    checkDataState();
  }, []);

  return { dataState, isLoading, error };
}
