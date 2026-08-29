/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBenchmarkRun, cancelBenchmarkRun } from '@/services/client/benchmarkApi';
import type { RunConfigInput } from '@/types';

function stream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(({ event, data }) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

describe('benchmarkApi unified file-capable runner', () => {
  const config = {
    name: 'Manual run', agentKey: 'demo', modelId: 'demo-model', concurrency: 1,
  } as RunConfigInput;

  beforeEach(() => { jest.restoreAllMocks(); });

  it('posts every benchmark Run action to the unified evaluation-runs route', async () => {
    const completed = { id: 'eval-run-1', status: 'completed', results: {} };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: stream([
      { event: 'started', data: { runId: 'eval-run-1', testCases: [{ id: 'tc-1', name: 'Case' }] } },
      { event: 'progress', data: { runId: 'eval-run-1', testCaseId: 'tc-1', startedCount: 1, completedCount: 0, totalTestCases: 1, status: 'running' } },
      { event: 'completed', data: completed },
    ]) }) as any;
    const progress = jest.fn();
    const started = jest.fn();

    await expect(executeBenchmarkRun('bench-1', config, progress, started)).resolves.toEqual(completed);
    expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs', expect.objectContaining({ method: 'POST' }));
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
      sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }], benchmarkId: 'bench-1', trigger: 'ui',
    }));
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ runId: 'eval-run-1' }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ currentTestCaseIndex: 0 }));
  });

  it('surfaces a unified runner SSE error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: stream([
      { event: 'error', data: { error: 'source failed' } },
    ]) }) as any;
    await expect(executeBenchmarkRun('bench-1', config, jest.fn())).rejects.toThrow('source failed');
  });

  it('cancels through the same active-run registry', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as any;
    await expect(cancelBenchmarkRun('bench-1', 'eval-run-1')).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/eval-run-1/cancel', { method: 'POST' });
  });

  it('surfaces cancellation failures', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, statusText: 'Not Found', json: async () => ({ error: 'not active' }) }) as any;
    await expect(cancelBenchmarkRun('bench-1', 'eval-run-1')).rejects.toThrow('not active');
  });
});
