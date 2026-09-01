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
  type CaseReportRef,
  DEEP_DIVE_MAX_DISTINCT_CASES,
  DEEP_DIVE_MAX_TOOL_CALLS,
} from '@/server/services/comparisonTraceTools';
import type { ComparisonRunInput } from '@/server/services/comparisonDeepDiveService';

interface CapturedTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

const RUNS: ComparisonRunInput[] = [
  { key: 'A', label: 'agent A', runId: 'run-A', reportId: 'rep-default-a' },
  { key: 'B', label: 'agent B', runId: 'run-B', reportId: 'rep-default-b' },
];
const DEFAULT_CASE_ID = 'tc-default';

function collectTools(
  capture: DeepDiveCapture = {},
  opts: {
    caseReports?: Map<string, CaseReportRef>;
    getReport?: (reportId: string) => Promise<any | null>;
  } = {}
): { tools: Map<string, CapturedTool>; capture: DeepDiveCapture } {
  const tools = new Map<string, CapturedTool>();
  const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
  const caseReports = opts.caseReports ?? new Map<string, CaseReportRef>();
  const getReport = opts.getReport ?? (async () => null);
  createComparisonTraceExtension(RUNS, DEFAULT_CASE_ID, caseReports, getReport, 'http://localhost:4055', capture)(pi);
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
    expect(() =>
      createComparisonTraceExtension(RUNS, DEFAULT_CASE_ID, new Map(), async () => null, 'http://localhost:4055')(pi)
    ).not.toThrow();
  });

  describe('query_spans — comparison-wide case selection', () => {
    const globalFetch = global.fetch;
    afterEach(() => {
      global.fetch = globalFetch;
    });

    function mockTracesResponse(spans: any[]) {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ spans }),
      })) as any;
    }

    it('uses the default run/case (no fetch) when caseId is omitted', async () => {
      mockTracesResponse([{ spanId: 'sp1', traceId: 't1', name: 'agent.run' }]);
      const getReport = jest.fn(async () => null);
      const { tools, capture } = collectTools({}, { getReport });

      const res = await tools.get('query_spans')!.execute('t1', { run: 'A' });
      const parsed = parseText(res);

      expect(getReport).not.toHaveBeenCalled();
      expect(parsed.caseId).toBe(DEFAULT_CASE_ID);
      expect(parsed.runId).toBe('run-A');
      expect(parsed.spanCount).toBe(1);
      // The default case gets recorded as visited too.
      expect(capture.visitedCases).toEqual([
        expect.objectContaining({ key: 'A', caseId: DEFAULT_CASE_ID, reportId: 'rep-default-a', runId: 'run-A' }),
      ]);
    });

    it('resolves an ARBITRARY case by caseId, fetching ONLY that case\'s report (lazy, not prefetched)', async () => {
      mockTracesResponse([{ spanId: 'sp2', traceId: 't2', name: 'agent.run' }]);
      const caseReports = new Map<string, CaseReportRef>([
        ['tc-other', { a: 'rep-other-a', b: 'rep-other-b' }],
      ]);
      const getReport = jest.fn(async (id: string) =>
        id === 'rep-other-a' ? { runId: 'run-other-a', agentKey: 'demo' } : null
      );
      const { tools, capture } = collectTools({}, { caseReports, getReport });

      const res = await tools.get('query_spans')!.execute('t1', { run: 'A', caseId: 'tc-other' });
      const parsed = parseText(res);

      // Only the ONE requested report was fetched — never the whole table.
      expect(getReport).toHaveBeenCalledTimes(1);
      expect(getReport).toHaveBeenCalledWith('rep-other-a');
      expect(parsed.caseId).toBe('tc-other');
      expect(parsed.runId).toBe('run-other-a');
      expect(capture.visitedCases).toEqual([
        expect.objectContaining({ key: 'A', caseId: 'tc-other', reportId: 'rep-other-a', runId: 'run-other-a' }),
      ]);
    });

    it('errors (no fetch) when the requested side has no report for that case', async () => {
      const caseReports = new Map<string, CaseReportRef>([
        ['tc-b-only', { b: 'rep-b-only' }], // side A never ran this case
      ]);
      const getReport = jest.fn(async () => null);
      const { tools, capture } = collectTools({}, { caseReports, getReport });

      const res = await tools.get('query_spans')!.execute('t1', { run: 'A', caseId: 'tc-b-only' });
      const parsed = parseText(res);

      expect(getReport).not.toHaveBeenCalled();
      expect(parsed.error).toMatch(/No report for run A on case 'tc-b-only'/);
      expect(capture.visitedCases).toBeUndefined();
    });

    it('errors when caseId is unknown to the results table at all', async () => {
      const { tools } = collectTools();
      const res = await tools.get('query_spans')!.execute('t1', { run: 'A', caseId: 'tc-does-not-exist' });
      expect(parseText(res).error).toMatch(/No report for run A on case 'tc-does-not-exist'/);
    });

    it('errors when the resolved report has no runId/window at all', async () => {
      const caseReports = new Map<string, CaseReportRef>([['tc-notraceable', { a: 'rep-notraceable' }]]);
      const getReport = jest.fn(async () => ({ /* no runId, no serviceable agentKey/timestamp-derivable window */ }));
      const { tools } = collectTools({}, { caseReports, getReport });

      const res = await tools.get('query_spans')!.execute('t1', { run: 'A', caseId: 'tc-notraceable' });
      expect(parseText(res).error).toMatch(/traces unavailable for this case/);
    });

    it('errors on an unknown run key regardless of caseId', async () => {
      const { tools } = collectTools();
      const res = await tools.get('query_spans')!.execute('t1', { run: 'C', caseId: 'tc-default' });
      expect(parseText(res).error).toMatch(/Unknown run 'C'/);
    });

    it('dedupes visitedCases by reportId across repeated calls for the same case', async () => {
      mockTracesResponse([{ spanId: 'sp1', traceId: 't1', name: 'agent.run' }]);
      const { tools, capture } = collectTools();
      await tools.get('query_spans')!.execute('t1', { run: 'A' });
      await tools.get('query_spans')!.execute('t2', { run: 'A', nameFilter: 'agent' });
      expect(capture.visitedCases).toHaveLength(1);
    });
  });

  describe('amplification guards (hardening round, codex review of PR #460)', () => {
    function mockTracesResponse(spans: any[] = []) {
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ spans }) })) as any;
    }
    const globalFetch = global.fetch;
    afterEach(() => {
      global.fetch = globalFetch;
    });

    /** N distinct, individually-traceable cases (tc-0 .. tc-{n-1}), each with its own resolvable report. */
    function manyCaseReports(n: number): { caseReports: Map<string, CaseReportRef>; getReport: jest.Mock } {
      const caseReports = new Map<string, CaseReportRef>();
      for (let i = 0; i < n; i++) {
        caseReports.set(`tc-${i}`, { a: `rep-${i}-a`, b: `rep-${i}-b` });
      }
      const getReport = jest.fn(async (id: string) => ({ runId: `run-${id}`, agentKey: 'demo' }));
      return { caseReports, getReport };
    }

    it('allows exactly DEEP_DIVE_MAX_DISTINCT_CASES distinct (non-default) cases to be lazily fetched', async () => {
      mockTracesResponse();
      const { caseReports, getReport } = manyCaseReports(DEEP_DIVE_MAX_DISTINCT_CASES);
      const { tools } = collectTools({}, { caseReports, getReport });

      for (let i = 0; i < DEEP_DIVE_MAX_DISTINCT_CASES; i++) {
        const res = await tools.get('query_spans')!.execute(`t${i}`, { run: 'A', caseId: `tc-${i}` });
        expect(parseText(res).error).toBeUndefined();
      }
      expect(getReport).toHaveBeenCalledTimes(DEEP_DIVE_MAX_DISTINCT_CASES);
    });

    it('blocks the (N+1)th DISTINCT case with a polite budget-exhausted error, without ever fetching its report', async () => {
      mockTracesResponse();
      const { caseReports, getReport } = manyCaseReports(DEEP_DIVE_MAX_DISTINCT_CASES + 1);
      const { tools } = collectTools({}, { caseReports, getReport });

      for (let i = 0; i < DEEP_DIVE_MAX_DISTINCT_CASES; i++) {
        await tools.get('query_spans')!.execute(`t${i}`, { run: 'A', caseId: `tc-${i}` });
      }
      const overBudget = await tools.get('query_spans')!.execute('t-over', { run: 'A', caseId: `tc-${DEEP_DIVE_MAX_DISTINCT_CASES}` });
      const parsed = parseText(overBudget);

      expect(parsed.error).toMatch(/Case budget exhausted/i);
      expect(parsed.error).toMatch(new RegExp(`max ${DEEP_DIVE_MAX_DISTINCT_CASES}`));
      // The (N+1)th case's report was never fetched -- the budget check is
      // BEFORE the lazy fetch, not after.
      expect(getReport).toHaveBeenCalledTimes(DEEP_DIVE_MAX_DISTINCT_CASES);
    });

    it('re-querying an ALREADY-counted case stays free even once the distinct-case budget is exhausted', async () => {
      mockTracesResponse();
      const { caseReports, getReport } = manyCaseReports(DEEP_DIVE_MAX_DISTINCT_CASES);
      const { tools } = collectTools({}, { caseReports, getReport });

      for (let i = 0; i < DEEP_DIVE_MAX_DISTINCT_CASES; i++) {
        await tools.get('query_spans')!.execute(`t${i}`, { run: 'A', caseId: `tc-${i}` });
      }
      // Re-query case tc-0 (already counted) on side B (a fresh report fetch
      // for the OTHER side of an already-visited case is not a NEW distinct
      // case) -- must succeed, not be blocked by the exhausted budget.
      const again = await tools.get('query_spans')!.execute('t-again', { run: 'B', caseId: 'tc-0' });
      expect(parseText(again).error).toBeUndefined();
    });

    it('the DEFAULT case (no caseId) never counts against the distinct-case budget', async () => {
      mockTracesResponse();
      const { caseReports, getReport } = manyCaseReports(DEEP_DIVE_MAX_DISTINCT_CASES);
      const { tools } = collectTools({}, { caseReports, getReport });

      for (let i = 0; i < DEEP_DIVE_MAX_DISTINCT_CASES; i++) {
        await tools.get('query_spans')!.execute(`t${i}`, { run: 'A', caseId: `tc-${i}` });
      }
      // The budget is already fully consumed by the loop above; the DEFAULT
      // case (no caseId, already-resolved report, no lazy fetch) must still
      // succeed since it was never counted in the first place.
      const defaultCase = await tools.get('query_spans')!.execute('t-default', { run: 'A' });
      expect(parseText(defaultCase).error).toBeUndefined();
    });

    it('shares the SAME distinct-case budget between query_spans and query_logs (one generation, one budget)', async () => {
      mockTracesResponse();
      const { caseReports, getReport } = manyCaseReports(DEEP_DIVE_MAX_DISTINCT_CASES + 1);
      const { tools } = collectTools({}, { caseReports, getReport });

      for (let i = 0; i < DEEP_DIVE_MAX_DISTINCT_CASES; i++) {
        await tools.get('query_spans')!.execute(`t${i}`, { run: 'A', caseId: `tc-${i}` });
      }
      // query_logs, not query_spans, hits the SAME exhausted budget.
      const res = await tools.get('query_logs')!.execute('t-logs', { run: 'A', caseId: `tc-${DEEP_DIVE_MAX_DISTINCT_CASES}` });
      expect(parseText(res).error).toMatch(/Case budget exhausted/i);
    });

    it('caps the OVERALL tool-call count at DEEP_DIVE_MAX_TOOL_CALLS, independent of the case budget', async () => {
      mockTracesResponse();
      // A single case, repeatedly re-queried -- never hits the case budget,
      // but SHOULD hit the overall tool-call budget.
      const { tools } = collectTools();
      let lastError: string | undefined;
      for (let i = 0; i < DEEP_DIVE_MAX_TOOL_CALLS + 5; i++) {
        const res = await tools.get('query_spans')!.execute(`t${i}`, { run: 'A' });
        lastError = parseText(res).error;
      }
      expect(lastError).toMatch(/Tool-call budget exhausted/i);
      expect(lastError).toMatch(new RegExp(`max ${DEEP_DIVE_MAX_TOOL_CALLS}`));
    });

    it('the tool-call budget is per-generation: a FRESH createComparisonTraceExtension call gets a fresh budget', async () => {
      mockTracesResponse();
      const { tools: tools1 } = collectTools();
      for (let i = 0; i < DEEP_DIVE_MAX_TOOL_CALLS; i++) {
        await tools1.get('query_spans')!.execute(`t${i}`, { run: 'A' });
      }
      const exhausted = await tools1.get('query_spans')!.execute('t-over', { run: 'A' });
      expect(parseText(exhausted).error).toMatch(/Tool-call budget exhausted/i);

      // A brand-new extension instance (a new job/generation) is NOT affected
      // by the previous instance's exhausted budget.
      const { tools: tools2 } = collectTools();
      const fresh = await tools2.get('query_spans')!.execute('t-fresh', { run: 'A' });
      expect(parseText(fresh).error).toBeUndefined();
    });

    it('counts query_logs calls against the SAME overall tool-call budget as query_spans', async () => {
      mockTracesResponse();
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })) as any;
      const { tools } = collectTools();
      for (let i = 0; i < DEEP_DIVE_MAX_TOOL_CALLS; i++) {
        await tools.get('query_logs')!.execute(`t${i}`, { run: 'A' });
      }
      const res = await tools.get('query_spans')!.execute('t-over', { run: 'A' });
      expect(parseText(res).error).toMatch(/Tool-call budget exhausted/i);
    });
  });
});
