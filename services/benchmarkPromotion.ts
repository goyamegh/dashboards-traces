/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

export async function promoteRunToBenchmark(
  runId: string,
  benchmarkName: string,
  storage: IStorageModule
): Promise<{ benchmark: Benchmark; run: EvaluationRun }> {
  // 1. Fetch the run
  const run = await storage.evaluationRuns.getById(runId);
  if (!run) {
    throw new Error('Evaluation run not found');
  }

  // 2. Check if already associated
  if (run.benchmarkId) {
    throw new Error('Run is already associated with a benchmark');
  }

  // 3. Get test case IDs from snapshots
  const testCaseIds = run.testCaseSnapshots.map(s => s.id);

  // 4. Try to find existing benchmark by name
  const { items: allBenchmarks } = await storage.benchmarks.getAll();
  const existingBenchmark = allBenchmarks.find(b => b.name === benchmarkName);

  let benchmark: Benchmark;

  if (existingBenchmark) {
    // 5. Update existing benchmark
    benchmark = await storage.benchmarks.update(existingBenchmark.id, { testCaseIds });
  } else {
    // 6. Create new benchmark
    benchmark = await storage.benchmarks.create({
      name: benchmarkName,
      testCaseIds,
      description: `Promoted from run ${run.name || run.id}`,
    });
  }

  // 7. Link the run to the benchmark
  const updatedRun = await storage.evaluationRuns.update(runId, { benchmarkId: benchmark.id });

  // 8. Return both
  return { benchmark, run: updatedRun };
}
