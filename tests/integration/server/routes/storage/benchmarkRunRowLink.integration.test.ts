/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the "Claude Code run row not clickable on the
 * benchmark runs page" bug — real Express route wiring, mocked storage
 * adapter (same pattern as the existing
 * tests/integration/services/storage/benchmark-stats-refresh.integration.test.ts).
 *
 * Root cause: `benchmark.runs[]` is only populated when a run-first
 * evaluation-run doc COMPLETES (`linkCompletedRunToBenchmark` in
 * server/routes/storage/evaluationRuns.ts runs at completion, not at create
 * time). A still-`running` evaluation-run tied to a benchmark therefore has
 * NO entry in `benchmark.runs[]` even though the standalone doc already
 * exists. The runs LIST page (components/evals3/BenchmarkRunsPage.tsx)
 * already unions `benchmark.runs[]` with
 * `GET /api/storage/evaluation-runs?benchmarkId=...`, so the row shows up
 * mid-run — but the run INSPECTOR page (components/evals3/RunInspectorPage.tsx)
 * used to look ONLY in `benchmark.runs[]` and silently `navigate()` back to
 * the runs list when the run wasn't there yet. From the user's perspective,
 * clicking the row did nothing.
 *
 * The fix falls back to `GET /api/storage/evaluation-runs/:id` when the run
 * is absent from `benchmark.runs[]`. This test exercises the REAL route
 * handlers (not mocked) for both calls the fix makes, against a benchmark
 * whose embedded `runs[]` genuinely does not (yet) contain a run that DOES
 * exist as a standalone, in-progress evaluation-run document — the exact
 * "CLI/UI-started run appears linkable mid-run" scenario.
 */

import type { Application } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const BENCHMARK_ID = 'bench-cc-row-link';
const RUN_ID = 'eval-run-cc-row-link-mid-run';

const RUNNING_EVAL_RUN = {
  id: RUN_ID,
  name: 'ClaudeCode-WithTraces-001',
  status: 'running',
  agentKey: 'cc-os-rag-stark-retail',
  modelId: 'us.anthropic.claude-sonnet-4-6',
  judgeModelId: 'agent-trace-judge',
  sources: [{ type: 'benchmark', benchmarkId: BENCHMARK_ID }],
  benchmarkId: BENCHMARK_ID,
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'Case 1' }],
  results: { 'tc-1': { status: 'running' } },
  createdAt: '2026-09-01T04:57:22.482Z',
};

// benchmark.runs[] does NOT contain RUN_ID — reproduces the not-yet-linked
// (still running) precondition the bug depends on.
const BENCHMARK_WITHOUT_EMBEDDED_RUN = {
  id: BENCHMARK_ID,
  name: 'retail-retrieval-benchmark',
  testCaseIds: ['tc-1'],
  runs: [],
};

const mockBenchmarkGetById = jest.fn();
const mockEvalRunGetById = jest.fn();
const mockEvalRunList = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    isConfigured: jest.fn().mockReturnValue(true),
    benchmarks: {
      getById: (...args: unknown[]) => mockBenchmarkGetById(...args),
    },
    evaluationRuns: {
      getById: (...args: unknown[]) => mockEvalRunGetById(...args),
      list: (...args: unknown[]) => mockEvalRunList(...args),
    },
    runs: {
      getById: jest.fn().mockResolvedValue(null),
    },
  }),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

describe('Benchmark run row link — mid-run linkability (real routes, mocked storage)', () => {
  let app: Application;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBenchmarkGetById.mockResolvedValue(BENCHMARK_WITHOUT_EMBEDDED_RUN);
    mockEvalRunGetById.mockResolvedValue(RUNNING_EVAL_RUN);
    mockEvalRunList.mockResolvedValue({ items: [RUNNING_EVAL_RUN], total: 1 });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    app = express();
    app.use(express.json());

    const benchmarksRouter = await import('@/server/routes/storage/benchmarks');
    const evaluationRunsRouter = await import('@/server/routes/storage/evaluationRuns');
    app.use(benchmarksRouter.default);
    app.use(evaluationRunsRouter.default);
  });

  it('confirms the precondition: benchmark.runs[] does not contain the still-running run', async () => {
    const res = await request(app).get(`/api/storage/benchmarks/${BENCHMARK_ID}`);
    expect(res.status).toBe(200);
    expect((res.body.runs || []).some((r: { id: string }) => r.id === RUN_ID)).toBe(false);
  });

  it('serves the standalone evaluation-run doc via GET .../evaluation-runs/:id — the fallback RunInspectorPage.tsx now uses', async () => {
    const res = await request(app).get(`/api/storage/evaluation-runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: RUN_ID,
      status: 'running',
      benchmarkId: BENCHMARK_ID,
      name: 'ClaudeCode-WithTraces-001',
    });
    expect(mockEvalRunGetById).toHaveBeenCalledWith(RUN_ID);
  });

  it('serves the run via the benchmarkId-scoped list — the union query the runs LIST page already relied on', async () => {
    const res = await request(app).get(`/api/storage/evaluation-runs?benchmarkId=${BENCHMARK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.evaluationRuns.map((r: { id: string }) => r.id)).toContain(RUN_ID);
    expect(mockEvalRunList).toHaveBeenCalledWith(expect.objectContaining({ benchmarkId: BENCHMARK_ID }));
  });

  it('returns 404 (not a hang or 500) for a run id that exists in neither store — the genuine not-found case the inspector page now covers with an explicit error state', async () => {
    mockEvalRunGetById.mockResolvedValue(null);
    const res = await request(app).get('/api/storage/evaluation-runs/truly-gone');
    expect(res.status).toBe(404);
  });
});
