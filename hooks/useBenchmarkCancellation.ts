/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { cancelBenchmarkRun } from '@/services/client/benchmarkApi';

export interface UseBenchmarkCancellationReturn {
  cancellingRunId: string | null;
  isCancelling: (runId: string) => boolean;
  handleCancelRun: (
    benchmarkId: string,
    runId: string,
    onSuccess?: () => Promise<void> | void
  ) => Promise<void>;
}

/**
 * Hook to manage benchmark run cancellation state and actions.
 * Provides consistent cancel behavior across BenchmarksPage and BenchmarkRunsPage.
 */
export function useBenchmarkCancellation(): UseBenchmarkCancellationReturn {
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);

  const isCancelling = useCallback(
    (runId: string) => {
      return cancellingRunId === runId;
    },
    [cancellingRunId]
  );

  const handleCancelRun = useCallback(
    async (
      benchmarkId: string,
      runId: string,
      onSuccess?: () => Promise<void> | void
    ) => {
      setCancellingRunId(runId);
      try {
        await cancelBenchmarkRun(benchmarkId, runId);
        if (onSuccess) {
          await onSuccess();
        }
      } catch (error) {
        console.error('Failed to cancel run:', error);
      } finally {
        setCancellingRunId(null);
      }
    },
    []
  );

  return { cancellingRunId, isCancelling, handleCancelRun };
}
