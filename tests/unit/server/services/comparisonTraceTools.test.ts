/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive's in-process tools:
 *   - query_spans / query_logs: read-only, run-scoped to the two runs (A/B).
 *   - record_deepdive_extras: a single structured-output "recorder" tool the
 *     agent calls (at most once, both fields optional) as a side effect; its
 *     result is written into the shared `DeepDiveCapture` sink rather than
 *     parsed out of the agent's free-form markdown answer. A single combined
 *     tool (rather than two separate ones) keeps the chart + experiment ideas
 *     atomic in one call.
 */

import {
  createComparisonTraceExtension,
  type DeepDiveCapture,
} from '@/server/services/comparisonTraceTools';
import type { ComparisonRunInput } from '@/server/services/comparisonDeepDiveService';

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

  it('registers the span, log, and record-extras tools', () => {
    const tools = registerTools([{ key: 'A', label: 'Run A', runId: 'run-a' }]);
    expect(Object.keys(tools)).toEqual(['query_spans', 'query_logs', 'record_deepdive_extras']);
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

interface CapturedTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

const RUNS: ComparisonRunInput[] = [
  { key: 'A', label: 'agent A', runId: 'run-A' },
  { key: 'B', label: 'agent B', runId: 'run-B' },
];

function collectTools(capture: DeepDiveCapture = {}): { tools: Map<string, CapturedTool>; capture: DeepDiveCapture } {
  const tools = new Map<string, CapturedTool>();
  const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
  createComparisonTraceExtension(RUNS, 'http://localhost:4055', capture)(pi);
  return { tools, capture };
}

const parseText = (res: any) => JSON.parse(res.content[0].text);

describe('createComparisonTraceExtension', () => {
  it('registers query_spans, query_logs, record_deepdive_extras', () => {
    const { tools } = collectTools();
    expect([...tools.keys()].sort()).toEqual(['query_logs', 'query_spans', 'record_deepdive_extras']);
  });

  describe('record_deepdive_extras', () => {
    it('writes both chart and experiments into the capture sink from ONE call and acks', async () => {
      const { tools, capture } = collectTools();
      const params = {
        chart: {
          title: 'Tool usage & retries',
          series: [
            { label: 'Tool calls', a: 12, b: 7 },
            { label: 'Retries', a: 3, b: 0, unit: 'calls' },
          ],
        },
        experiments: [
          { title: 'Force a mid-task tool failure', rationale: 'A retried 3x on [span](span:run-A:sp1) but B never hit this path.' },
        ],
      };
      const res = await tools.get('record_deepdive_extras')!.execute('t1', params);
      expect(capture.chart).toEqual(params.chart);
      expect(capture.experiments).toEqual(params.experiments);
      expect(parseText(res)).toEqual({ recorded: true, chart: true, experimentsCount: 1 });
    });

    it('records chart only when experiments is omitted, and vice versa', async () => {
      const { tools, capture } = collectTools();
      await tools.get('record_deepdive_extras')!.execute('t1', {
        chart: { title: 'x', series: [{ label: 'a', a: 1, b: 2 }] },
      });
      expect(capture.chart).toBeDefined();
      expect(capture.experiments).toBeUndefined();

      const { tools: tools2, capture: capture2 } = collectTools();
      await tools2.get('record_deepdive_extras')!.execute('t2', {
        experiments: [{ title: 'idea', rationale: 'why' }],
      });
      expect(capture2.chart).toBeUndefined();
      expect(capture2.experiments).toHaveLength(1);
    });

    it('acks recorded:true even when called with neither chart nor experiments', async () => {
      const { tools, capture } = collectTools();
      const res = await tools.get('record_deepdive_extras')!.execute('t1', {});
      expect(parseText(res)).toEqual({ recorded: true, chart: false, experimentsCount: 0 });
      expect(capture.chart).toBeUndefined();
      expect(capture.experiments).toBeUndefined();
    });

    it('overwrites a previous chart if called again (agent is instructed to call once)', async () => {
      const { tools, capture } = collectTools();
      await tools.get('record_deepdive_extras')!.execute('t1', {
        chart: { title: 'first', series: [{ label: 'x', a: 1, b: 2 }] },
      });
      await tools.get('record_deepdive_extras')!.execute('t2', {
        chart: { title: 'second', series: [{ label: 'y', a: 3, b: 4 }] },
      });
      expect(capture.chart?.title).toBe('second');
    });
  });

  it('defaults the capture sink to a fresh object when none is passed', () => {
    const tools = new Map<string, CapturedTool>();
    const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
    // No capture arg — must not throw at registration time.
    expect(() => createComparisonTraceExtension(RUNS, 'http://localhost:4055')(pi)).not.toThrow();
  });
});
