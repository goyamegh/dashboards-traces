/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the evaluation-runs create/cancel routes' benchmark
 * projection wiring (server/routes/storage/evaluationRuns.ts).
 *
 * Regression covered: ongoing (in-progress) runs disappearing from the
 * Benchmark Details page / never appearing as failed there, because the
 * unified /api/storage/evaluation-runs route only ever linked
 * `benchmark.runs` on TERMINAL success — never at start, and never on
 * failure. See CHANGELOG "Fixed" entry for this fix.
 *
 * Mounts the real router on a bare Express app with every collaborator
 * mocked (storage adapter, source resolver, evaluation runner, config) —
 * same harness pattern as evaluationRunsImageDigest.test.ts.
 *
 * `mockBenchmarksGetById` is a DYNAMIC mock that mirrors whatever has been
 * recorded via `mockBenchmarksAddRun` so far, so the route's real
 * read-then-branch logic (`linkTerminalBenchmarkRunProjection`) sees a
 * realistic "already linked" benchmark once the starting projection has
 * landed — exactly like the real file/OpenSearch adapters would.
 */

const mockEvaluationRunsCreate = jest.fn();
const mockEvaluationRunsUpdate = jest.fn();
const mockEvaluationRunsUpdateResult = jest.fn();
const mockImagesCreate = jest.fn();
const mockImagesUpdate = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksAddRun = jest.fn();
const mockBenchmarksUpdateRun = jest.fn();
const mockBenchmarksUpdateRunResult = jest.fn();
const mockBenchmarksUpdate = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    evaluationRuns: {
      create: (...args: any[]) => mockEvaluationRunsCreate(...args),
      update: (...args: any[]) => mockEvaluationRunsUpdate(...args),
      updateResult: (...args: any[]) => mockEvaluationRunsUpdateResult(...args),
      getById: jest.fn(),
    },
    images: {
      create: (...args: any[]) => mockImagesCreate(...args),
      update: (...args: any[]) => mockImagesUpdate(...args),
    },
    benchmarks: {
      getById: (...args: any[]) => mockBenchmarksGetById(...args),
      addRun: (...args: any[]) => mockBenchmarksAddRun(...args),
      updateRun: (...args: any[]) => mockBenchmarksUpdateRun(...args),
      updateRunResult: (...args: any[]) => mockBenchmarksUpdateRunResult(...args),
      update: (...args: any[]) => mockBenchmarksUpdate(...args),
    },
  }),
}));

const mockResolveTestCaseSources = jest.fn();
jest.mock('@/services/sourceResolver', () => ({
  resolveTestCaseSources: (...args: any[]) => mockResolveTestCaseSources(...args),
}));

const mockExecuteEvaluationRun = jest.fn();
const mockCreateCancellationToken = jest.fn();
jest.mock('@/services/evaluationRunner', () => ({
  executeEvaluationRun: (...args: any[]) => mockExecuteEvaluationRun(...args),
  createCancellationToken: (...args: any[]) => mockCreateCancellationToken(...args),
}));

jest.mock('@/services/benchmarkPromotion', () => ({
  promoteRunToBenchmark: jest.fn(),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({ agents: [] }),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/resolveAgentModel', () => ({
  resolveAgentModel: jest.fn().mockReturnValue('resolved-model'),
}));

jest.mock('@/lib/benchmarkImage', () => ({
  computeImageDigest: jest.fn().mockReturnValue('digest-xyz'),
  buildImageDoc: jest.fn().mockReturnValue({ digest: 'digest-xyz' }),
}));

import express, { Application } from 'express';
const request = require('supertest');
import evaluationRunsRouter, { isEvaluationRunActiveInThisProcess } from '@/server/routes/storage/evaluationRuns';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(evaluationRunsRouter);
  return app;
}

const sampleTestCase = { id: 'tc-1', name: 'TC 1', version: 1 };

/** Fire a request without awaiting full completion (the SSE stream may stay
 * open indefinitely). Returns the underlying supertest promise so callers
 * can optionally await it later, once the mocked execution has resolved. */
function fireCreate(app: Application, body: any) {
  const req = request(app).post('/api/storage/evaluation-runs').send(body);
  const settled = req.then(() => {}, () => {});
  return { req, settled };
}

/**
 * Resolve as soon as `mockFn` is next called, without relying on a fixed
 * real-time delay (flaky under full-suite CPU contention where a fixed
 * `setTimeout` tick may not be enough). Wraps the mock's current
 * implementation so the original behavior (return value) is preserved.
 */
function waitForNextCall(mockFn: jest.Mock): Promise<void> {
  return new Promise<void>((resolve) => {
    const original = mockFn.getMockImplementation();
    mockFn.mockImplementation((...args: any[]) => {
      mockFn.mockImplementation(original as any);
      resolve();
      return original ? (original as any)(...args) : undefined;
    });
  });
}

describe('Evaluation Runs API — benchmark projection wiring', () => {
  let app: Application;
  let cancellationToken: { isCancelled: boolean; cancel: () => void };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = makeApp();

    mockResolveTestCaseSources.mockResolvedValue({
      testCases: [sampleTestCase],
      sources: [],
      evaluateFnMap: {},
      hooksByFile: {},
      testHookScopes: {},
    });
    cancellationToken = { isCancelled: false, cancel: jest.fn() };
    mockCreateCancellationToken.mockReturnValue(cancellationToken);
    mockEvaluationRunsCreate.mockResolvedValue(undefined);
    mockEvaluationRunsUpdate.mockImplementation(async (id: string, updates: any) => ({
      id, docType: 'evaluation-run', benchmarkId: 'bm-1', testCaseSnapshots: [sampleTestCase], ...updates,
    }));
    mockImagesCreate.mockResolvedValue({ digest: 'digest-xyz' });
    mockImagesUpdate.mockResolvedValue({ digest: 'digest-xyz' });

    // Dynamic: mirrors whatever addRun has recorded so far, so
    // linkTerminalBenchmarkRunProjection's "already linked?" read sees
    // reality, exactly like the real adapters would.
    mockBenchmarksGetById.mockImplementation(async () => ({
      id: 'bm-1',
      currentVersion: 2,
      testCaseIds: ['tc-1'],
      runs: mockBenchmarksAddRun.mock.results
        .filter(r => r.type === 'return')
        .map((_r, i) => mockBenchmarksAddRun.mock.calls[i][1]),
    }));
    mockBenchmarksAddRun.mockResolvedValue(true);
    mockBenchmarksUpdateRun.mockResolvedValue(true);
    mockBenchmarksUpdateRunResult.mockResolvedValue(true);
    mockBenchmarksUpdate.mockResolvedValue({ id: 'bm-1' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const body = { sources: [{ testCaseId: 'tc-1' }], agentKey: 'demo', benchmarkId: 'bm-1' };

  describe('run start', () => {
    it('links a running projection into benchmark.runs BEFORE execution, stamped with the benchmark current version', async () => {
      let resolveExecute: (v: any) => void = () => {};
      mockExecuteEvaluationRun.mockImplementation(() => new Promise(resolve => { resolveExecute = resolve; }));
      // Wait for executeEvaluationRun itself to be invoked (not just addRun)
      // — addRun resolving and the route reaching the executeEvaluationRun
      // call are two SEPARATE microtask ticks (sendSSE/activeCancellationTokens
      // in between), so signaling off addRun alone raced `resolveExecute`
      // being assigned (flaky under full-suite load). By the time this
      // resolves, addRun has necessarily already completed (it happens
      // strictly before, in the same synchronous continuation).
      const executeInvoked = waitForNextCall(mockExecuteEvaluationRun);

      const { settled } = fireCreate(app, body);
      await executeInvoked;

      expect(mockBenchmarksAddRun).toHaveBeenCalledTimes(1);
      const [benchmarkId, projection] = mockBenchmarksAddRun.mock.calls[0];
      expect(benchmarkId).toBe('bm-1');
      expect(projection.status).toBe('running');
      expect(projection.benchmarkVersion).toBe(2);
      expect(projection.results).toEqual({ 'tc-1': { reportId: '', status: 'pending' } });

      resolveExecute({ results: {}, stats: { total: 1 } });
      await settled;
    });

    it('does not link anything when the run has no benchmarkId', async () => {
      mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 1 } });
      await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: undefined });
      expect(mockBenchmarksAddRun).not.toHaveBeenCalled();
    });

    it('is best-effort: a failing addRun does not abort run creation/execution', async () => {
      mockBenchmarksAddRun.mockRejectedValue(new Error('cluster hiccup'));
      mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 1 } });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(mockExecuteEvaluationRun).toHaveBeenCalled();
      const calls = (console.error as jest.Mock).mock.calls.map(c => c.join(' '));
      expect(calls.some(c => c.includes('Failed to link starting run') && c.includes('cluster hiccup'))).toBe(true);
    });
  });

  describe('per-test-case progress', () => {
    it('mirrors onTestCaseComplete into the benchmark projection via updateRunResult', async () => {
      const result = { reportId: 'report-1', status: 'completed' as const };
      mockExecuteEvaluationRun.mockImplementation(async (_run: any, _testCases: any, opts: any) => {
        await opts.onTestCaseComplete('tc-1', result);
        return { results: { 'tc-1': result }, stats: { total: 1, passed: 1, failed: 0, pending: 0, errored: 0 } };
      });

      await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(mockBenchmarksUpdateRunResult).toHaveBeenCalledWith('bm-1', expect.any(String), 'tc-1', result);
    });

    it('is best-effort: a failing updateRunResult does not abort the run', async () => {
      mockBenchmarksUpdateRunResult.mockRejectedValue(new Error('conflict'));
      const result = { reportId: 'report-1', status: 'completed' as const };
      mockExecuteEvaluationRun.mockImplementation(async (_run: any, _testCases: any, opts: any) => {
        await opts.onTestCaseComplete('tc-1', result);
        return { results: { 'tc-1': result }, stats: { total: 1 } };
      });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);
    });
  });

  describe('terminal success', () => {
    it('UPDATEs the existing benchmark.runs entry (not addRun again) with terminal status/stats', async () => {
      mockExecuteEvaluationRun.mockResolvedValue({
        results: { 'tc-1': { reportId: 'report-1', status: 'completed' } },
        stats: { total: 1, passed: 1, failed: 0, pending: 0, errored: 0 },
      });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(mockBenchmarksAddRun).toHaveBeenCalledTimes(1); // starting link only
      expect(mockBenchmarksUpdateRun).toHaveBeenCalledTimes(1); // terminal link uses update
      const [, runId, projection] = mockBenchmarksUpdateRun.mock.calls[0];
      expect(runId).toBe(mockBenchmarksAddRun.mock.calls[0][1].id);
      expect(projection.status).toBe('completed');
      expect(projection.stats).toEqual({ total: 1, passed: 1, failed: 0, pending: 0, errored: 0 });
    });

    it('is best-effort: a failing terminal link does not turn a successful run into an SSE error', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bm-1', runs: [] }); // never "already linked"
      mockBenchmarksAddRun
        .mockResolvedValueOnce(true) // starting link succeeds
        .mockResolvedValueOnce(false); // terminal fallback addRun "fails"
      mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 0 } });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      const calls = (console.error as jest.Mock).mock.calls.map(c => c.join(' '));
      expect(calls.some(c => c.includes('failed to sync benchmark'))).toBe(true);
      // The run's own terminal write still happened (source of truth intact).
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'completed' })
      );
    });
  });

  describe('failure path', () => {
    it('syncs the benchmark projection to failed (previously never touched at all)', async () => {
      mockExecuteEvaluationRun.mockRejectedValue(new Error('agent unreachable'));

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(mockBenchmarksAddRun).toHaveBeenCalledTimes(1); // starting link only
      expect(mockBenchmarksUpdateRun).toHaveBeenCalledTimes(1);
      const [, , projection] = mockBenchmarksUpdateRun.mock.calls[0];
      expect(projection.status).toBe('failed');
    });

    it('is best-effort: a failing sync on the failure path does not crash the request', async () => {
      let getByIdCalls = 0;
      mockBenchmarksGetById.mockImplementation(async () => {
        getByIdCalls++;
        // First call is the create route's own "does this benchmark exist"
        // check — must succeed so the run is actually created. Only the
        // SECOND call (inside linkTerminalBenchmarkRunProjection, from the
        // failure catch) simulates storage going down.
        if (getByIdCalls === 1) {
          return { id: 'bm-1', currentVersion: 2, testCaseIds: ['tc-1'], runs: [] };
        }
        throw new Error('storage down');
      });
      mockExecuteEvaluationRun.mockRejectedValue(new Error('agent unreachable'));

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);
      const calls = (console.error as jest.Mock).mock.calls.map(c => c.join(' '));
      expect(calls.some(c => /failed and also failed to sync benchmark/.test(c))).toBe(true);
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/cancel', () => {
    it('syncs the benchmark projection to cancelled', async () => {
      let resolveExecute: (v: any) => void = () => {};
      mockExecuteEvaluationRun.mockImplementation(() => new Promise(resolve => { resolveExecute = resolve; }));
      const executeInvoked = waitForNextCall(mockExecuteEvaluationRun);

      const { settled } = fireCreate(app, body);
      await executeInvoked;

      const runId = mockBenchmarksAddRun.mock.calls[0]?.[1]?.id;
      expect(runId).toBeDefined();
      expect(isEvaluationRunActiveInThisProcess(runId)).toBe(true);

      const cancelRes = await request(app).post(`/api/storage/evaluation-runs/${runId}/cancel`);
      expect(cancelRes.status).toBe(200);
      expect(mockBenchmarksUpdateRun).toHaveBeenCalledWith(
        'bm-1', runId, expect.objectContaining({ status: 'cancelled' })
      );

      cancellationToken.isCancelled = true;
      resolveExecute({ results: {}, stats: { total: 1 } });
      await settled;
    });
  });
});
