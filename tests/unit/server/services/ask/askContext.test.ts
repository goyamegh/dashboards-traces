/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  askLinks,
  buildAskSnapshot,
  buildAskSystemPrompt,
  buildAskUserPrompt,
  deriveAskRefs,
  resolveAskRefs,
} from '@/server/services/ask/askContext';
import type { IStorageModule } from '@/server/adapters/types';

describe('deriveAskRefs — ids from PATH routes', () => {
  it('run inspector: benchmark + evaluation run + reportId query', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect?reportId=report-3')).toEqual({
      benchmarkId: 'bench-1',
      runId: 'eval-run-2',
      reportId: 'report-3',
    });
  });

  it('run inspector without a selected report', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect')).toEqual({ benchmarkId: 'bench-1', runId: 'eval-run-2' });
  });

  it('benchmark case page', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/cases/tc-9')).toEqual({ benchmarkId: 'bench-1', testCaseId: 'tc-9' });
  });

  it('evaluation run detail (no benchmark)', () => {
    expect(deriveAskRefs('/evaluations/runs/eval-run-2')).toEqual({ runId: 'eval-run-2' });
    expect(deriveAskRefs('/evaluations/runs/eval-run-2/inspect?reportId=report-3')).toEqual({ runId: 'eval-run-2', reportId: 'report-3' });
    expect(deriveAskRefs('/evaluations/runs/new')).toEqual({});
  });

  it('compare page: benchmark + comparison run ids (which are RUN ids, not report ids)', () => {
    expect(deriveAskRefs('/compare/bench-1?runs=run-a,run-b,%20run-c')).toEqual({
      benchmarkId: 'bench-1',
      comparisonRunIds: ['run-a', 'run-b', 'run-c'],
    });
    expect(deriveAskRefs('/compare')).toEqual({});
  });

  it('legacy run details routes carry a REPORT id', () => {
    expect(deriveAskRefs('/runs/report-3')).toEqual({ reportId: 'report-3' });
    expect(deriveAskRefs('/benchmarks/bench-1/runs/report-3')).toEqual({ benchmarkId: 'bench-1', reportId: 'report-3' });
  });

  it('test case routes', () => {
    expect(deriveAskRefs('/evaluations/test-cases/tc-9')).toEqual({ testCaseId: 'tc-9' });
    expect(deriveAskRefs('/test-cases/tc-9/runs')).toEqual({ testCaseId: 'tc-9' });
  });

  it('traceId / testCaseId query params', () => {
    expect(deriveAskRefs('/agent-traces?traceId=abc')).toEqual({ traceId: 'abc' });
  });

  it('decodes URI-encoded ids and ignores id-less pages', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench%201')).toEqual({ benchmarkId: 'bench 1' });
    expect(deriveAskRefs('/')).toEqual({});
    expect(deriveAskRefs('/settings')).toEqual({});
  });
});

describe('resolveAskRefs — client params win over the route', () => {
  it('merges and prefers client-supplied ids', () => {
    expect(resolveAskRefs({ route: '/evaluations/benchmarks/b/runs/r/inspect', params: { reportId: 'report-x', benchmarkId: '' } })).toEqual({
      benchmarkId: 'b',
      runId: 'r',
      reportId: 'report-x',
    });
  });
});

describe('askLinks — PATH-routed, never hash routes', () => {
  it('builds inspector / compare / test-case links', () => {
    expect(askLinks.report('b', 'r', 'rep')).toBe('/evaluations/benchmarks/b/runs/r/inspect?reportId=rep');
    expect(askLinks.report(undefined, 'r', 'rep')).toBe('/evaluations/runs/r/inspect?reportId=rep');
    expect(askLinks.report(undefined, undefined, 'rep')).toBe('/runs/rep');
    expect(askLinks.compare('b', ['x', 'y'])).toBe('/compare/b?runs=x,y');
    expect(askLinks.testCase('tc')).toBe('/evaluations/test-cases/tc');
    for (const l of [askLinks.report('b', 'r', 'rep'), askLinks.compare('b', ['x']), askLinks.run('b', 'r'), askLinks.benchmark('b')]) {
      expect(l).not.toContain('#');
    }
  });
});

// ---------------------------------------------------------------------------

function fakeStorage(data: {
  reports?: Record<string, any>;
  evaluationRuns?: Record<string, any>;
  testCases?: Record<string, any>;
  benchmarks?: Record<string, any>;
  byExperimentRun?: Record<string, any[]>;
}): IStorageModule {
  return {
    runs: {
      getById: async (id: string) => data.reports?.[id] ?? null,
      getByExperimentRun: async (b: string, r: string) => data.byExperimentRun?.[`${b}/${r}`] ?? [],
    },
    evaluationRuns: { getById: async (id: string) => data.evaluationRuns?.[id] ?? null },
    testCases: { getById: async (id: string) => data.testCases?.[id] ?? null },
    benchmarks: { getById: async (id: string) => data.benchmarks?.[id] ?? null },
  } as unknown as IStorageModule;
}

describe('buildAskSnapshot', () => {
  const report = {
    id: 'report-3',
    testCaseId: 'tc-9',
    experimentRunId: 'eval-run-2',
    experimentId: 'bench-1',
    traceId: 'trace-abc',
    passFailStatus: 'failed',
    status: 'completed',
    llmJudgeReasoning: 'Fact precision 12.5/100: cited 1 of 8 gold products.',
    trajectory: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, timestamp: i, type: 'assistant', content: `step ${i}` })),
  };
  const evaluationRun = {
    id: 'eval-run-2',
    name: 'Nightly',
    status: 'completed',
    agentKey: 'cc',
    benchmarkId: 'bench-1',
    testCaseSnapshots: [{ id: 'tc-9', name: 'vocab_649', version: 1 }],
    results: { 'tc-9': { reportId: 'report-3', status: 'failed', passFailStatus: 'failed' } },
    stats: { passed: 0, failed: 1, pending: 0, total: 1 },
  };

  it('follows a report to its run, test case and benchmark, emits PATH links and trims the trajectory', async () => {
    const storage = fakeStorage({
      reports: { 'report-3': report },
      evaluationRuns: { 'eval-run-2': evaluationRun },
      testCases: { 'tc-9': { id: 'tc-9', name: 'vocab_649', versions: [{ initialPrompt: 'find X', expectedOutcomes: ['returns 474'] }] } },
      benchmarks: { 'bench-1': { id: 'bench-1', name: 'retail', testCaseIds: ['tc-9'], runs: [{ id: 'eval-run-2', name: 'Nightly', stats: {} }] } },
    });
    const snap = await buildAskSnapshot(storage, { reportId: 'report-3' });
    expect(snap.refs).toEqual({ reportId: 'report-3', testCaseId: 'tc-9', runId: 'eval-run-2', benchmarkId: 'bench-1', traceId: 'trace-abc' });
    expect(snap.loaded).toEqual(['report report-3', 'run eval-run-2', 'test case tc-9', 'benchmark bench-1']);
    expect(snap.markdown).toContain('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect?reportId=report-3');
    expect(snap.markdown).toContain('Fact precision 12.5/100');
    expect(snap.markdown).toContain('"trajectoryTotalSteps": 40');
    expect(snap.markdown).toContain('"trajectoryIncluded": "complete"');
    expect(snap.markdown).toContain('"i": 39');
    expect(snap.markdown).toContain('"vocab_649: failed"');
    expect(snap.markdown).toContain('"testCase": "vocab_649"'); // notPassed carries the report id
    expect(snap.markdown).toContain('returns 474');
    expect(snap.markdown).not.toContain('/#/');
  });

  it('compare page: cross-tabulates per-case verdicts and names regressions deterministically', async () => {
    const mk = (id: string, name: string, byCase: Record<string, string>) => ({
      id, name, status: 'completed', agentKey: 'a',
      testCaseSnapshots: Object.keys(byCase).map((tc) => ({ id: tc, name: `case ${tc}`, version: 1 })),
      results: Object.fromEntries(Object.entries(byCase).map(([tc, v]) => [tc, { reportId: `rep-${id}-${tc}`, status: v, passFailStatus: v }])),
      stats: {},
    });
    const storage = fakeStorage({
      evaluationRuns: {
        base: mk('base', 'baseline', { t1: 'passed', t2: 'passed', t3: 'failed' }),
        cand: mk('cand', 'candidate', { t1: 'passed', t2: 'failed', t3: 'passed' }),
      },
      benchmarks: { b: { id: 'b', name: 'bench', testCaseIds: ['t1', 't2', 't3'], runs: [] } },
    });
    const snap = await buildAskSnapshot(storage, { benchmarkId: 'b', comparisonRunIds: ['base', 'cand', 'missing'] });
    expect(snap.markdown).toContain('| case t2 (t2) | passed | failed |');
    expect(snap.markdown).toMatch(/regressed .*: case t2;/);
    expect(snap.markdown).toMatch(/improved: case t3/);
    expect(snap.markdown).toContain('Comparison runs not found: missing');
    // report ids for the changed cases so the agent can read the judge reasoning
    expect(snap.markdown).toContain('- case t2: baseline → rep-base-t2; candidate → rep-cand-t2');
    expect(snap.markdown).toContain('- case t3: baseline → rep-base-t3; candidate → rep-cand-t3');
    expect(snap.markdown).not.toContain('- case t1:');
    expect(snap.markdown).toContain('/compare/b?runs=base,cand,missing');
  });

  it('legacy benchmark runs (not evaluation-run docs) fall back to their reports', async () => {
    const storage = fakeStorage({
      byExperimentRun: { 'b/run-legacy': [{ id: 'rep1', testCaseId: 't1', passFailStatus: 'passed' }] },
    });
    const snap = await buildAskSnapshot(storage, { benchmarkId: 'b', comparisonRunIds: ['run-legacy'] });
    expect(snap.loaded).toContain('run run-legacy (1 reports)');
    expect(snap.markdown).toContain('| t1 (t1) | passed |');
  });

  it('never throws: a failing lookup becomes a note the agent can act on', async () => {
    const storage = {
      runs: { getById: async () => { throw new Error('cluster down'); } },
      evaluationRuns: { getById: async () => null },
      testCases: { getById: async () => null },
      benchmarks: { getById: async () => null },
    } as unknown as IStorageModule;
    const snap = await buildAskSnapshot(storage, { reportId: 'r', runId: 'x' });
    expect(snap.markdown).toContain('Failed to load: cluster down');
    expect(snap.markdown).toContain('Not found as an evaluation run');
    expect(snap.loaded).toEqual([]);
  });

  it('returns an empty snapshot for id-less pages', async () => {
    const snap = await buildAskSnapshot(fakeStorage({}), {});
    expect(snap.markdown).toBe('');
  });
});

describe('prompt assembly', () => {
  it('system prompt names exactly the read-only tools, tells the model the snapshot is complete, and forbids hash routes', () => {
    const p = buildAskSystemPrompt();
    for (const t of ['get_report(reportId)', 'get_evaluation_run(runId)', 'get_test_case(testCaseId)', 'get_benchmark(benchmarkId)', 'query_spans(']) expect(p).toContain(t);
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('do NOT re-fetch those');
    expect(p).toContain('Never use hash routes');
    expect(p).not.toMatch(/bash|curl|shell/i);
  });

  it('follow-ups on the same page carry no snapshot (pi keeps it in the session context)', () => {
    const p = buildAskUserPrompt({ question: 'And then?', selections: [], page: { route: '/x' }, refs: {}, snapshotMarkdown: '', isFollowUp: true });
    expect(p).toContain('Follow-up: the data snapshot from earlier in this conversation still applies');
    expect(p.trim().endsWith('## Question\nAnd then?')).toBe(true);
  });

  it('user prompt quotes selections, ids, snapshot and the question in order', () => {
    const p = buildAskUserPrompt({
      question: 'Why?',
      selections: [{ text: 'line one\nline two', nearbyText: 'surrounding paragraph with line one' }],
      page: { route: '/compare/b?runs=x,y', title: 'Compare' },
      refs: { benchmarkId: 'b', comparisonRunIds: ['x', 'y'] },
      snapshotMarkdown: '## Data snapshot\nstuff',
    });
    const order = ['## Page', 'benchmarkId=b; comparisonRunIds=x,y', '> line one\n> line two', 'Surrounding text', '## Data snapshot', '## Question\nWhy?'];
    let last = -1;
    for (const needle of order) {
      const i = p.indexOf(needle);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
  });
});
