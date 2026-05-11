/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvaluationRun,
  TestCase,
  BenchmarkRunStatus,
  RunResultStatus,
  RunStats,
  AgentConfig,
  RunPerformanceMetrics,
} from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { runEvaluationWithConnector } from '@/services/evaluation';
import { connectorRegistry } from '@/services/connectors/server';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import { CancellationToken, createCancellationToken } from './benchmarkRunner';

export type { CancellationToken } from './benchmarkRunner';
export { createCancellationToken } from './benchmarkRunner';

export interface EvaluationRunProgress {
  runId: string;
  testCaseId: string;
  startedCount: number;
  completedCount: number;
  totalTestCases: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface ExecuteEvaluationRunOptions {
  cancellationToken?: CancellationToken;
  storageModule: IStorageModule;
  onProgress: (progress: EvaluationRunProgress) => void;
  onTestCaseComplete?: (testCaseId: string, result: {
    reportId: string;
    status: RunResultStatus;
    error?: string;
  }) => Promise<void>;
}

/**
 * Safely load config with fallback to defaults.
 */
function getConfig() {
  try {
    return loadConfigSync();
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Run async tasks with bounded concurrency.
 * Uses a sliding-window approach: starts new tasks as previous ones complete,
 * maintaining up to `limit` tasks running at once.
 */
async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  isCancelled?: () => boolean
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    if (isCancelled?.()) break;
    const p = fn(item).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Execute an EvaluationRun against a set of resolved test cases.
 *
 * This is the source-agnostic execution engine. It takes resolved test cases
 * directly instead of looking them up from a benchmark, making it usable for
 * ad-hoc runs, benchmark runs, and scheduled runs alike.
 */
export async function executeEvaluationRun(
  run: EvaluationRun,
  testCases: TestCase[],
  options: ExecuteEvaluationRunOptions
): Promise<EvaluationRun> {
  const { cancellationToken, storageModule, onProgress, onTestCaseComplete } = options;
  const totalTestCases = testCases.length;
  const concurrency = run.concurrency ?? 1;
  const runStartTime = Date.now();

  console.log(`[EvaluationRunner] Starting run ${run.id} with concurrency=${concurrency} for ${totalTestCases} test cases`);

  // Build agent config
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const baseAgent = allAgents.find(a => a.key === run.agentKey);

  if (!baseAgent) {
    throw new Error(`Agent not found: ${run.agentKey}`);
  }

  const agentConfig: AgentConfig = {
    ...baseAgent,
    endpoint: run.agentEndpoint || baseAgent.endpoint,
    headers: {
      ...baseAgent.headers,
      ...run.headers,
    },
  };

  // Resolve model ID
  const modelConfig = config.models[run.modelId];
  const bedrockModelId = modelConfig?.model_id || run.modelId;

  // Initialize results if not already set
  if (!run.results) {
    run.results = {};
  }

  // Mutable counters for tracking progress across concurrent tasks
  let completedCount = 0;
  let startedCount = 0;

  // Shared throttle signal for rate-limit backoff
  let throttleUntil = 0;
  let consecutiveThrottles = 0;

  try {
    await runWithConcurrencyLimit(
      testCases,
      concurrency,
      async (testCase: TestCase) => {
        const testCaseId = testCase.id;

        // Check for cancellation before starting
        if (cancellationToken?.isCancelled) {
          return;
        }

        // Wait if a sibling task recently hit a rate-limit error
        const now = Date.now();
        if (now < throttleUntil) {
          await new Promise(r => setTimeout(r, throttleUntil - now));
        }

        // Report progress — this test case is starting
        startedCount++;
        onProgress({
          runId: run.id,
          testCaseId,
          startedCount,
          completedCount,
          totalTestCases,
          status: 'running',
        });

        debug('EvaluationRunner', `[${testCaseId}] Starting evaluation (${completedCount}/${totalTestCases} completed)`);

        // Set status to running
        run.results[testCaseId] = { reportId: '', status: 'running' };

        try {
          // Run the evaluation using connector
          const report = await runEvaluationWithConnector(
            agentConfig,
            bedrockModelId,
            testCase,
            () => {}, // No debug callback needed
            { registry: connectorRegistry, evaluatorId: run.evaluatorId }
          );

          // Save the report via storage module
          const savedReport = await storageModule.runs.create(report as any);

          // Update result with success
          const status: RunResultStatus = 'completed';
          run.results[testCaseId] = {
            reportId: savedReport.id,
            status,
          };

          completedCount++;
          consecutiveThrottles = Math.max(0, consecutiveThrottles - 1);
          debug('EvaluationRunner', `[${testCaseId}] Completed (${completedCount}/${totalTestCases})`);

          // Notify caller
          onProgress({
            runId: run.id,
            testCaseId,
            startedCount,
            completedCount,
            totalTestCases,
            status: 'running',
          });

          if (onTestCaseComplete) {
            await onTestCaseComplete(testCaseId, run.results[testCaseId]);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          debug('EvaluationRunner', `[${testCaseId}] Failed: ${errorMsg}`);
          run.results[testCaseId] = { reportId: '', status: 'failed', error: errorMsg };

          completedCount++;

          // Signal sibling tasks to back off with exponential backoff
          if (errorMsg.includes('ThrottlingException') || errorMsg.includes('rate limit') || errorMsg.includes('429')) {
            consecutiveThrottles++;
            const backoffMs = Math.min(5000 * Math.pow(2, consecutiveThrottles - 1), 30000);
            throttleUntil = Math.max(throttleUntil, Date.now() + backoffMs);
            await new Promise(r => setTimeout(r, backoffMs));
          }

          // Notify caller
          onProgress({
            runId: run.id,
            testCaseId,
            startedCount,
            completedCount,
            totalTestCases,
            status: 'running',
          });

          if (onTestCaseComplete) {
            await onTestCaseComplete(testCaseId, run.results[testCaseId]);
          }
        }
      },
      () => cancellationToken?.isCancelled ?? false
    );

    // Determine final status
    const wasCancelled = cancellationToken?.isCancelled ?? false;
    const finalStatus: BenchmarkRunStatus = wasCancelled ? 'cancelled' : 'completed';

    // Compute stats from results
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const result of Object.values(run.results)) {
      if (result.status === 'completed') {
        // Check if the underlying report passed
        // For now, count completed as needing further resolution
        // We'll check passFailStatus from saved reports
        passed++; // Will be refined by caller if needed
      } else if (result.status === 'failed') {
        failed++;
      } else {
        pending++;
      }
    }

    run.stats = {
      passed,
      failed,
      pending,
      total: totalTestCases,
    };

    // Compute performance metrics
    const totalDuration = Date.now() - runStartTime;
    const testCaseDurations = Object.values(run.results)
      .map(r => r.performanceMetrics?.durationMs)
      .filter((d): d is number => d !== undefined);

    run.performanceMetrics = {
      durationMs: totalDuration,
      concurrency,
      avgTestCaseDurationMs: testCaseDurations.length > 0
        ? testCaseDurations.reduce((a, b) => a + b, 0) / testCaseDurations.length : 0,
      maxTestCaseDurationMs: testCaseDurations.length > 0 ? Math.max(...testCaseDurations) : 0,
      minTestCaseDurationMs: testCaseDurations.length > 0 ? Math.min(...testCaseDurations) : 0,
    };

    run.status = finalStatus;
    run.completedAt = new Date().toISOString();

    // Final progress notification
    onProgress({
      runId: run.id,
      testCaseId: testCases[totalTestCases - 1]?.id ?? '',
      startedCount,
      completedCount,
      totalTestCases,
      status: finalStatus === 'cancelled' ? 'cancelled' : 'completed',
    });

    console.log(`[EvaluationRunner] Run ${run.id} ${finalStatus}: ${completedCount}/${totalTestCases} test cases in ${totalDuration}ms`);

    return run;
  } catch (error) {
    // Mark any pending test cases as failed
    const errorMsg = error instanceof Error ? error.message : String(error);
    for (const testCase of testCases) {
      if (!run.results[testCase.id] || run.results[testCase.id].status === 'pending' || run.results[testCase.id].status === 'running') {
        run.results[testCase.id] = { reportId: '', status: 'failed', error: `Execution failed: ${errorMsg}` };
      }
    }

    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = errorMsg;

    throw error;
  }
}
