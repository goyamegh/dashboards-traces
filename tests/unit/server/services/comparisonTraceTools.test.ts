/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive's in-process tools:
 *   - query_spans / query_logs: read-only, run-scoped to the two runs (A/B).
 *   - record_metric_chart / record_experiment_suggestions: structured-output
 *     "recorder" tools the agent calls as side effects; their results are
 *     written into the shared `DeepDiveCapture` sink rather than parsed out
 *     of the agent's free-form markdown answer.
 */

import {
  createComparisonTraceExtension,
  type DeepDiveCapture,
} from '@/server/services/comparisonTraceTools';
import type { ComparisonRunInput } from '@/server/services/comparisonDeepDiveService';

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
  it('registers query_spans, query_logs, record_metric_chart, record_experiment_suggestions', () => {
    const { tools } = collectTools();
    expect([...tools.keys()].sort()).toEqual([
      'query_logs',
      'query_spans',
      'record_experiment_suggestions',
      'record_metric_chart',
    ]);
  });

  describe('record_metric_chart', () => {
    it('writes the chart into the capture sink and acks', async () => {
      const { tools, capture } = collectTools();
      const params = {
        title: 'Tool usage & retries',
        series: [
          { label: 'Tool calls', a: 12, b: 7 },
          { label: 'Retries', a: 3, b: 0, unit: 'calls' },
        ],
      };
      const res = await tools.get('record_metric_chart')!.execute('t1', params);
      expect(capture.chart).toEqual(params);
      expect(parseText(res)).toEqual({ recorded: true, seriesCount: 2 });
    });

    it('overwrites a previous chart if called again (agent is instructed to call once)', async () => {
      const { tools, capture } = collectTools();
      await tools.get('record_metric_chart')!.execute('t1', {
        title: 'first',
        series: [{ label: 'x', a: 1, b: 2 }],
      });
      await tools.get('record_metric_chart')!.execute('t2', {
        title: 'second',
        series: [{ label: 'y', a: 3, b: 4 }],
      });
      expect(capture.chart?.title).toBe('second');
    });
  });

  describe('record_experiment_suggestions', () => {
    it('writes the suggestions into the capture sink and acks', async () => {
      const { tools, capture } = collectTools();
      const params = {
        suggestions: [
          { title: 'Force a mid-task tool failure', rationale: 'A retried 3x on [span](span:run-A:sp1) but B never hit this path.' },
          { title: 'Add a second related ticket', rationale: 'Neither run explored cross-ticket linkage.' },
        ],
      };
      const res = await tools.get('record_experiment_suggestions')!.execute('t1', params);
      expect(capture.experiments).toEqual(params.suggestions);
      expect(parseText(res)).toEqual({ recorded: true, count: 2 });
    });
  });

  it('defaults the capture sink to a fresh object when none is passed', () => {
    const tools = new Map<string, CapturedTool>();
    const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
    // No capture arg — must not throw at registration time.
    expect(() => createComparisonTraceExtension(RUNS, 'http://localhost:4055')(pi)).not.toThrow();
  });
});
