/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';

describe('buildEvaluatorErrorPatch (issue #242)', () => {
  it('sets metricsStatus to error and zeroes the metrics', () => {
    const patch = buildEvaluatorErrorPatch('judge_failed', new Error('boom'));
    expect(patch.metricsStatus).toBe('error');
    expect(patch.metrics).toEqual({
      accuracy: 0,
      faithfulness: 0,
      latency_score: 0,
      trajectory_alignment_score: 0,
    });
  });

  it('clears passFailStatus so errored runs are not bucketed as passed', () => {
    const patch = buildEvaluatorErrorPatch('judge_failed', 'x');
    // Issue #242 review: must be `null`, not `undefined`. The storage
    // layer's `!== undefined` allow-list would filter `undefined` out
    // and leave a stale 'passed'/'failed' on disk; `null` actually
    // clears the persisted field.
    expect(patch.passFailStatus).toBeNull();
  });

  it('overwrites llmJudgeReasoning with the actual cause', () => {
    const patch = buildEvaluatorErrorPatch(
      'judge_failed',
      new Error('Bedrock Judge validation error (not retryable): Missing required field: expectedOutcomes or expectedTrajectory'),
    );
    // Must NOT be the legacy "Waiting for traces..." placeholder.
    expect(patch.llmJudgeReasoning).not.toMatch(/waiting for traces/i);
    expect(patch.llmJudgeReasoning).toContain('Evaluator could not run');
    expect(patch.llmJudgeReasoning).toContain('Missing required field: expectedOutcomes');
    expect(patch.llmJudgeReasoning).toContain('judge_failed');
  });

  it('records a machine-readable traceError with the kind label and kind token', () => {
    const cases: Array<[Parameters<typeof buildEvaluatorErrorPatch>[0], RegExp]> = [
      ['judge_failed', /^Judge evaluation failed \(kind=judge_failed\): /],
      ['trace_timeout', /^Traces never arrived \(kind=trace_timeout\): /],
      ['trace_incomplete', /^Trace did not converge \(kind=trace_incomplete\): /],
      ['trace_callback_failed', /^Post-trace callback failed \(kind=trace_callback_failed\): /],
      ['trace_fetch_failed', /^Trace fetch failed \(kind=trace_fetch_failed\): /],
      ['unknown', /^Evaluator error \(kind=unknown\): /],
    ];
    for (const [kind, re] of cases) {
      const patch = buildEvaluatorErrorPatch(kind, 'something');
      expect(patch.traceError).toMatch(re);
      // Also verify both pieces are independently greppable:
      // a log pipeline filtering by `kind=` should always succeed.
      expect(patch.traceError).toMatch(new RegExp(`kind=${kind}`));
    }
  });

  it('handles non-Error inputs without crashing or rendering [object Object]', () => {
    const patchString = buildEvaluatorErrorPatch('judge_failed', 'just a string');
    expect(patchString.traceError).toContain('just a string');

    const patchObj = buildEvaluatorErrorPatch('judge_failed', { foo: 'bar' });
    expect(patchObj.traceError).toContain('Unknown error');
    expect(patchObj.traceError).not.toContain('[object Object]');
    expect(patchObj.llmJudgeReasoning).not.toContain('[object Object]');
  });

  it('produces a self-contained surface message safe to render in the Judge tab', () => {
    const patch = buildEvaluatorErrorPatch('trace_timeout', 'no spans after 60 attempts');
    // Bold header for visibility, plus an explicit exclusion-from-aggregation note
    // so a user reading just the Judge tab knows the score isn't real.
    expect(patch.llmJudgeReasoning).toMatch(/\*\*Evaluator could not run\.\*\*/);
    expect(patch.llmJudgeReasoning).toMatch(/excluded from pass-rate aggregation/i);
  });
});

describe("buildEvaluatorErrorPatch('not_evaluable') — a deterministic evaluator whose rules do not apply", () => {
  it('is tagged not_evaluable (never judge_failed), keeps the errored bucket, and explains without blaming a judge', () => {
    const patch = buildEvaluatorErrorPatch('not_evaluable', 'Ranked retrieval: no candidate ids found in the final answer, a results tool or the stored tool results');
    expect(patch.metricsStatus).toBe('error');
    expect(patch.passFailStatus).toBeNull();
    expect(patch.traceError).toBe('Not evaluable (kind=not_evaluable): Ranked retrieval: no candidate ids found in the final answer, a results tool or the stored tool results');
    expect(patch.traceError).not.toMatch(/judge_failed/);
    expect(patch.llmJudgeReasoning).toMatch(/^\*\*Not evaluable by this evaluator\.\*\*/);
    expect(patch.llmJudgeReasoning).toMatch(/neither a failed verdict nor a judge error/);
    expect(patch.llmJudgeReasoning).toMatch(/pick an evaluator that fits these cases or add gold ids/i);
    expect(patch.llmJudgeReasoning).not.toMatch(/Evaluator could not run/);
    expect(patch.llmJudgeReasoning).toMatch(/\*\*Reason:\*\* Ranked retrieval: no candidate ids found/);
  });
});
