/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for isEvaluationRun -- the typed predicate that replaced the
 * `(run as any).docType === 'evaluation-run'` symptom patch (see
 * components/evals3/RunInspectorPage.tsx). Runtime-focused: the real value
 * of this guard is that it's a proper `r is EvaluationRun` type predicate
 * (verified by RunInspectorPage.tsx compiling with strict access to
 * EvaluationRun-only fields like `.rerunOf` after narrowing), but these
 * tests lock down its runtime discrimination against the two real shapes
 * that flow through the app: the first-class EvaluationRun doc and the
 * legacy BenchmarkRun projection embedded in benchmark.runs[] (which never
 * carries a docType field at all -- see
 * server/routes/storage/evaluationRuns.ts, the "benchmarkRun" object it
 * constructs server-side has no docType key).
 */

import { isEvaluationRun } from '@/types';
import type { BenchmarkRun, EvaluationRun } from '@/types';

const evaluationRun: EvaluationRun = {
  id: 'run-1',
  docType: 'evaluation-run',
  name: 'Run 1',
  createdAt: '2024-01-01T00:00:00Z',
  status: 'completed',
  agentKey: 'demo',
  modelId: 'model-1',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [],
  results: {},
};

// Realistic shape of the embedded projection: constructed server-side
// without a docType field (never `docType: undefined`, the key is simply
// absent -- matters because `'docType' in r` must handle both).
const benchmarkRun: BenchmarkRun = {
  id: 'run-2',
  name: 'Run 2',
  createdAt: '2024-01-01T00:00:00Z',
  agentKey: 'demo',
  modelId: 'model-1',
  results: {},
};

describe('isEvaluationRun', () => {
  it('returns true for a first-class EvaluationRun doc', () => {
    expect(isEvaluationRun(evaluationRun)).toBe(true);
  });

  it('returns false for the embedded BenchmarkRun projection (no docType key at all)', () => {
    expect(isEvaluationRun(benchmarkRun)).toBe(false);
  });

  it('returns false when docType is explicitly present but not evaluation-run', () => {
    // Defensive: a BenchmarkRun literal can't express this in TS, but the
    // predicate is read defensively (`'docType' in r && r.docType === ...`)
    // specifically so a stray/legacy docType value never mis-detects as an
    // evaluation-run.
    const withOtherDocType = { ...benchmarkRun, docType: 'benchmark-image' } as unknown as BenchmarkRun;
    expect(isEvaluationRun(withOtherDocType)).toBe(false);
  });

  it('narrows the type so EvaluationRun-only fields are accessible without a cast', () => {
    const run: BenchmarkRun | EvaluationRun = { ...evaluationRun, rerunOf: 'source-run' };
    if (isEvaluationRun(run)) {
      // Compiles only if narrowing worked -- `rerunOf` doesn't exist on BenchmarkRun.
      expect(run.rerunOf).toBe('source-run');
      expect(run.sources).toEqual([]);
    } else {
      throw new Error('expected isEvaluationRun(run) to be true');
    }
  });
});
