/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildEvaluationRunFromEmbedded,
  migrateEvaluationRuns,
} from '@/cli/migrations/evaluationRunsMigration.js';
import type { Benchmark, BenchmarkRun } from '@/types/index.js';

function embeddedRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-embedded-1',
    name: 'Embedded run',
    agentKey: 'demo',
    modelId: 'demo-model',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    results: { tc1: { status: 'completed', reportId: 'report-1' } },
    testCaseSnapshots: [{ id: 'tc1', version: 1, name: 'tc1' }],
    ...overrides,
  } as BenchmarkRun;
}

describe('buildEvaluationRunFromEmbedded', () => {
  it('preserves the original run id', () => {
    const run = embeddedRun();
    const evalRun = buildEvaluationRunFromEmbedded(run, 'bench-1');
    expect(evalRun.id).toBe('run-embedded-1');
  });

  it('stamps benchmarkId and a matching sources[] entry', () => {
    const run = embeddedRun();
    const evalRun = buildEvaluationRunFromEmbedded(run, 'bench-1');
    expect(evalRun.benchmarkId).toBe('bench-1');
    expect(evalRun.sources).toEqual([{ type: 'benchmark', benchmarkId: 'bench-1' }]);
  });

  it('carries over results, testCaseSnapshots, and stats unchanged', () => {
    const run = embeddedRun({ stats: { passed: 1, failed: 0, pending: 0, total: 1 } });
    const evalRun = buildEvaluationRunFromEmbedded(run, 'bench-1');
    expect(evalRun.results).toEqual(run.results);
    expect(evalRun.testCaseSnapshots).toEqual(run.testCaseSnapshots);
    expect(evalRun.stats).toEqual(run.stats);
  });

  it('falls back to a truncated-id name when the run has no name', () => {
    const run = embeddedRun({ name: undefined as any });
    const evalRun = buildEvaluationRunFromEmbedded(run, 'bench-1');
    expect(evalRun.name).toBe(`Run ${run.id.slice(0, 8)}`);
  });
});

describe('migrateEvaluationRuns', () => {
  const benchmark: Benchmark = {
    id: 'bench-1',
    name: 'Bench 1',
    testCaseIds: ['tc1'],
    runs: [embeddedRun()],
  } as unknown as Benchmark;

  function mockFetch(handlers: {
    onGet?: (url: string) => { ok: boolean; status?: number };
    onPut?: (url: string, body: any) => { ok: boolean; status?: number };
  }) {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    const fn = jest.fn(async (url: string, init?: any) => {
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (method === 'GET') {
        const r = handlers.onGet?.(url) ?? { ok: false, status: 404 };
        return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 404), json: async () => ({}) } as any;
      }
      const r = handlers.onPut?.(url, body) ?? { ok: true, status: 200 };
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => ({}) } as any;
    });
    (global as any).fetch = fn;
    return calls;
  }

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it('defaults to dry-run: issues no PUT even when the run has not been migrated', async () => {
    const calls = mockFetch({ onGet: () => ({ ok: false }) });
    const summary = await migrateEvaluationRuns('http://localhost:9999', [benchmark]);

    expect(summary.dryRun).toBe(true);
    expect(summary.migrated).toBe(1);
    expect(summary.alreadyMigrated).toBe(0);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('--apply (dryRun: false) issues a PUT preserving the run id', async () => {
    const calls = mockFetch({ onGet: () => ({ ok: false }) });
    const summary = await migrateEvaluationRuns('http://localhost:9999', [benchmark], { dryRun: false });

    expect(summary.dryRun).toBe(false);
    expect(summary.migrated).toBe(1);
    const put = calls.find(c => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain('/api/storage/evaluation-runs/run-embedded-1');
    expect(put!.body.id).toBe('run-embedded-1');
    expect(put!.body.benchmarkId).toBe('bench-1');
  });

  it('is idempotent: a run that already exists as a top-level doc is skipped, not re-PUT', async () => {
    const calls = mockFetch({ onGet: () => ({ ok: true }) });
    const summary = await migrateEvaluationRuns('http://localhost:9999', [benchmark], { dryRun: false });

    expect(summary.alreadyMigrated).toBe(1);
    expect(summary.migrated).toBe(0);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('counts a failed PUT as an error with details, not a silent success', async () => {
    mockFetch({ onGet: () => ({ ok: false }), onPut: () => ({ ok: false, status: 500 }) });
    const summary = await migrateEvaluationRuns('http://localhost:9999', [benchmark], { dryRun: false });

    expect(summary.errors).toBe(1);
    expect(summary.errorDetails[0].runId).toBe('run-embedded-1');
    expect(summary.migrated).toBe(0);
  });

  it('handles multiple benchmarks and totals runs across all of them', async () => {
    mockFetch({ onGet: () => ({ ok: false }) });
    const benchmark2: Benchmark = {
      id: 'bench-2',
      name: 'Bench 2',
      testCaseIds: [],
      runs: [embeddedRun({ id: 'run-embedded-2' }), embeddedRun({ id: 'run-embedded-3' })],
    } as unknown as Benchmark;

    const summary = await migrateEvaluationRuns('http://localhost:9999', [benchmark, benchmark2]);
    expect(summary.totalEmbeddedRuns).toBe(3);
    expect(summary.migrated).toBe(3);
  });
});
