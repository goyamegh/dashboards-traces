/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeRerunName, buildRerunConfig } from '@/lib/evaluationRerun';
import type { EvaluationRun } from '@/types';

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'My Run',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }],
    trigger: 'ui',
    testCaseSnapshots: [
      { id: 'tc-1', version: 1, name: 'Case 1' },
      { id: 'tc-2', version: 1, name: 'Case 2' },
    ],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

describe('computeRerunName', () => {
  it('appends "(re-run)" to a plain name', () => {
    expect(computeRerunName('My Run')).toBe('My Run (re-run)');
  });

  it('increments an existing "(re-run)" suffix to "(re-run 2)"', () => {
    expect(computeRerunName('My Run (re-run)')).toBe('My Run (re-run 2)');
  });

  it('increments an existing numbered suffix', () => {
    expect(computeRerunName('My Run (re-run 2)')).toBe('My Run (re-run 3)');
    expect(computeRerunName('My Run (re-run 9)')).toBe('My Run (re-run 10)');
  });

  it('is case-insensitive on the suffix and tolerates extra whitespace', () => {
    expect(computeRerunName('My Run (RE-RUN)')).toBe('My Run (re-run 2)');
    expect(computeRerunName('My Run   (re-run 4)')).toBe('My Run (re-run 5)');
  });

  it('falls back to a default base name when the source name is missing/blank', () => {
    expect(computeRerunName(undefined)).toBe('Evaluation Run (re-run)');
    expect(computeRerunName(null as any)).toBe('Evaluation Run (re-run)');
    expect(computeRerunName('   ')).toBe('Evaluation Run (re-run)');
  });

  it('does not confuse a name that merely contains the word "rerun" without the suffix shape', () => {
    expect(computeRerunName('rerun-of-baseline')).toBe('rerun-of-baseline (re-run)');
  });

  it('falls back to the default base name when the suffix has no prefix (codex_review finding)', () => {
    // A source literally named "(re-run)" (no prefix) would otherwise
    // capture an empty baseName and produce " (re-run 2)" (leading space).
    expect(computeRerunName('(re-run)')).toBe('Evaluation Run (re-run 2)');
    expect(computeRerunName('(re-run 5)')).toBe('Evaluation Run (re-run 6)');
  });
});

describe('buildRerunConfig', () => {
  it('duplicates a fully-populated run with no defaults applied', () => {
    const run = makeRun({
      judgeModelId: 'judge-model',
      evaluatorId: 'evaluator-1',
      headers: { 'X-Test': '1' },
      concurrency: 3,
      agentEndpoint: 'https://example.com',
      description: 'desc',
      benchmarkId: 'bm-1',
      benchmarkVersion: 2,
    });

    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    const { config, defaultsApplied } = result as any;

    expect(config).toEqual({
      sources: run.sources,
      agentKey: 'demo',
      modelId: 'claude-sonnet',
      judgeModelId: 'judge-model',
      evaluatorId: 'evaluator-1',
      headers: { 'X-Test': '1' },
      concurrency: 3,
      agentEndpoint: 'https://example.com',
      description: 'desc',
      benchmarkId: 'bm-1',
      benchmarkVersion: 2,
    });
    expect(defaultsApplied).toEqual([]);
  });

  it('derives sources from testCaseSnapshots when sources is missing (legacy run) and reports it', () => {
    const run = makeRun({ sources: undefined as any });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    const { config, defaultsApplied } = result as any;

    expect(config.sources).toEqual([{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }]);
    expect(defaultsApplied.some((n: string) => n.includes('sources'))).toBe(true);
  });

  it('derives sources from testCaseSnapshots when sources is an empty array', () => {
    const run = makeRun({ sources: [] });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    expect((result as any).config.sources).toEqual([{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }]);
  });

  it('errors when both sources and testCaseSnapshots are missing (nothing to run)', () => {
    const run = makeRun({ sources: undefined as any, testCaseSnapshots: [] });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(true);
    expect((result as any).error).toMatch(/no test cases to re-run/i);
  });

  it('errors when agentKey is missing', () => {
    const run = makeRun({ agentKey: undefined as any });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(true);
    expect((result as any).error).toMatch(/agentKey/i);
  });

  it('defaults concurrency to 1 when missing and reports it', () => {
    const run = makeRun({ concurrency: undefined });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    const { config, defaultsApplied } = result as any;
    expect(config.concurrency).toBe(1);
    expect(defaultsApplied.some((n: string) => n.includes('concurrency'))).toBe(true);
  });

  it('preserves concurrency=0 as-is (falsy but explicitly set, not "missing")', () => {
    // 0 is a deliberate (if unusual) value; only null/undefined count as "missing".
    const run = makeRun({ concurrency: 0 });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    expect((result as any).config.concurrency).toBe(0);
    expect((result as any).defaultsApplied).toEqual([]);
  });

  it('does not report evaluatorId/judgeModelId as defaults when simply unset (legitimately optional)', () => {
    const run = makeRun({ evaluatorId: undefined, judgeModelId: undefined, concurrency: 1 });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    const { config, defaultsApplied } = result as any;
    expect(config.evaluatorId).toBeUndefined();
    expect(config.judgeModelId).toBeUndefined();
    expect(defaultsApplied).toEqual([]);
  });

  it('falls back to an empty string modelId when missing (agent resolution happens downstream)', () => {
    const run = makeRun({ modelId: undefined as any });
    const result = buildRerunConfig(run);
    expect('error' in result).toBe(false);
    expect((result as any).config.modelId).toBe('');
  });
});
