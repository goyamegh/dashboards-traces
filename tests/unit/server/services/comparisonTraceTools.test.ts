/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createComparisonTraceExtension } from '@/server/services/comparisonTraceTools';

function registerTools(runs: any[], serverUrl = 'http://server.test') {
  const tools: Record<string, any> = {};
  const factory = createComparisonTraceExtension(runs as any, serverUrl);
  factory({
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
  } as any);
  return tools;
}

describe('comparisonTraceTools', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('registers the span and log tools', () => {
    const tools = registerTools([{ key: 'A', label: 'Run A', runId: 'run-a' }]);
    expect(Object.keys(tools)).toEqual(['query_spans', 'query_logs']);
  });

  it('returns helpful errors for unknown runs and runs without trace hints', async () => {
    const tools = registerTools([{ key: 'A', label: 'Run A' }]);

    const unknown = await tools.query_spans.execute('tool-1', { run: 'Z' });
    expect(unknown.details.error).toBe('Unknown run \'Z\'. Pass run: "A".');

    const unavailable = await tools.query_spans.execute('tool-2', { run: 'A' });
    expect(unavailable.details).toEqual({
      run: 'A',
      error: 'No runId or window hints for this run — traces unavailable.',
    });

    const unknownLogs = await tools.query_logs.execute('tool-3', { run: 'B' });
    expect(unknownLogs.details.error).toBe('Unknown run \'B\'. Pass run: "A".');
  });

  it('queries traces, applies name filtering, and preserves warning metadata', async () => {
    const tools = registerTools([
      {
        key: 'A',
        label: 'Run A',
        runId: 'run-a',
        agents: [{ serviceName: 'svc-a', startedAt: 10, endedAt: 20 }],
      },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        spans: [
          { spanId: 's1', traceId: 't1', name: 'SearchLogs', startTime: '1', endTime: '2', status: 'OK', attributes: { a: 1 } },
          { spanId: 's2', traceId: 't2', name: 'ReadFile', startTime: '3', endTime: '4', status: 'OK', attributes: { b: 2 } },
        ],
        warning: 'partial data',
      }),
    });

    const result = await tools.query_spans.execute('tool-4', { run: 'A', nameFilter: 'search' });

    expect(global.fetch).toHaveBeenCalledWith('http://server.test/api/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: 500,
        runIds: ['run-a'],
        agents: [{ serviceName: 'svc-a', startedAt: 10, endedAt: 20 }],
      }),
    });
    expect(result.details).toEqual({
      run: 'A',
      runId: 'run-a',
      label: 'Run A',
      spanCount: 1,
      spans: [
        {
          spanId: 's1',
          traceId: 't1',
          name: 'SearchLogs',
          startTime: '1',
          endTime: '2',
          status: 'OK',
          attributes: { a: 1 },
        },
      ],
      warning: 'partial data',
    });
  });

  it('surfaces trace fetch HTTP failures and exceptions', async () => {
    const tools = registerTools([{ key: 'A', label: 'Run A', runId: 'run-a' }]);

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
    const httpError = await tools.query_spans.execute('tool-5', { run: 'A' });
    expect(httpError.details).toEqual({
      run: 'A',
      error: 'traces query failed: HTTP 503',
    });

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('socket hang up'));
    const thrownError = await tools.query_spans.execute('tool-6', { run: 'A' });
    expect(thrownError.details).toEqual({
      run: 'A',
      error: 'traces query error: socket hang up',
    });
  });

  it('queries logs for a run and returns the service payload verbatim in details', async () => {
    const tools = registerTools([{ key: 'A', label: 'Run A', runId: 'run-a' }]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ logs: [{ message: 'boom' }], total: 1 }),
    });

    const result = await tools.query_logs.execute('tool-7', { run: 'A', query: 'boom' });

    expect(global.fetch).toHaveBeenCalledWith('http://server.test/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-a', query: 'boom', size: 200 }),
    });
    expect(result.details).toEqual({
      run: 'A',
      runId: 'run-a',
      logs: [{ message: 'boom' }],
      total: 1,
    });
  });

  it('surfaces log fetch unavailability, HTTP failures, and exceptions', async () => {
    const missingRunIdTools = registerTools([{ key: 'A', label: 'Run A' }]);
    const unavailable = await missingRunIdTools.query_logs.execute('tool-8', { run: 'A' });
    expect(unavailable.details).toEqual({
      run: 'A',
      error: 'No runId for this run — logs unavailable.',
    });

    const tools = registerTools([{ key: 'A', label: 'Run A', runId: 'run-a' }]);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    const httpError = await tools.query_logs.execute('tool-9', { run: 'A' });
    expect(httpError.details).toEqual({
      run: 'A',
      error: 'logs query failed: HTTP 404',
    });

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network timeout'));
    const thrownError = await tools.query_logs.execute('tool-10', { run: 'A' });
    expect(thrownError.details).toEqual({
      run: 'A',
      error: 'logs query error: network timeout',
    });
  });
});
