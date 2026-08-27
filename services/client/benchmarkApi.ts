/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for benchmark execution
 *
 * Handles SSE streaming from the server-side benchmark runner
 * with proper chunk buffering for incomplete events.
 */

import { BenchmarkRun, BenchmarkProgress, BenchmarkStartedEvent, RunConfigInput } from '@/types';
import { debug } from '@/lib/debug';
import { executeEvaluationRun } from './evaluationRunsApi';

/**
 * Execute a benchmark run via the server-side API with SSE streaming.
 *
 * The server executes the benchmark in the background and streams progress
 * events. Even if the client disconnects, the server continues execution.
 *
 * @param benchmarkId - The benchmark ID to run
 * @param runConfig - Configuration for the run (agent, model, etc.)
 * @param onProgress - Callback for progress updates
 * @param onStarted - Optional callback when run starts with test case list
 * @returns The completed BenchmarkRun
 */
export async function executeBenchmarkRun(
  benchmarkId: string,
  runConfig: RunConfigInput,
  onProgress: (progress: BenchmarkProgress) => void,
  onStarted?: (event: BenchmarkStartedEvent) => void
): Promise<BenchmarkRun> {
  debug('ClientAPI', 'Executing benchmark run through unified runner:', benchmarkId);
  const run = await executeEvaluationRun({
    name: runConfig.name,
    sources: [{ type: 'benchmark', benchmarkId }],
    agentKey: runConfig.agentKey,
    modelId: runConfig.modelId,
    judgeModelId: runConfig.judgeModelId,
    evaluatorId: runConfig.evaluatorId,
    concurrency: runConfig.concurrency,
    benchmarkId,
    trigger: 'ui',
    description: runConfig.description,
    agentEndpoint: runConfig.agentEndpoint,
    headers: runConfig.headers,
  }, progress => {
    onProgress({
      ...progress,
      currentRunId: progress.runId,
      currentTestCaseId: progress.testCaseId,
      currentTestCaseIndex: Math.max(0, progress.startedCount - 1),
      currentTestCase: { id: progress.testCaseId, name: progress.testCaseId },
    } as unknown as BenchmarkProgress);
  }, started => onStarted?.({
    runId: started.runId,
    testCases: started.testCases.map(testCase => ({ ...testCase, status: 'pending' as const })),
  }));
  return run as unknown as BenchmarkRun;


}

/**
 * Cancel an in-progress benchmark run.
 *
 * @param benchmarkId - The benchmark ID
 * @param runId - The run ID to cancel
 * @returns Whether the cancellation was successful
 */
export async function cancelBenchmarkRun(
  benchmarkId: string,
  runId: string
): Promise<boolean> {
  debug('ClientAPI', 'Cancelling unified benchmark run:', benchmarkId, runId);
  const response = await fetch(`/api/storage/evaluation-runs/${runId}/cancel`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to cancel run');
  }

  const result = await response.json();
  return result.success === true;
}

// Backwards compatibility aliases
/** @deprecated Use executeBenchmarkRun instead */
export const executeExperimentRun = executeBenchmarkRun;
/** @deprecated Use cancelBenchmarkRun instead */
export const cancelExperimentRun = cancelBenchmarkRun;
