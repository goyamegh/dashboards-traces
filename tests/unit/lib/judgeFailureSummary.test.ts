/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractJudgeFailureReason, computeJudgeFailureSummary } from '@/lib/judgeFailureSummary';

describe('extractJudgeFailureReason', () => {
  it('returns undefined for null/undefined reports', () => {
    expect(extractJudgeFailureReason(undefined)).toBeUndefined();
    expect(extractJudgeFailureReason(null)).toBeUndefined();
  });

  it('returns undefined for a normally passed/failed report', () => {
    expect(extractJudgeFailureReason({ status: 'completed' })).toBeUndefined();
    expect(extractJudgeFailureReason({ status: 'completed', metricsStatus: 'completed' })).toBeUndefined();
  });

  it('returns undefined for a genuine agent failure (buildEvaluatorErrorPatch kind=agent_failed)', () => {
    const report = {
      metricsStatus: 'error',
      traceError: 'Agent run did not complete (kind=agent_failed): Subprocess timed out after 600000ms',
    };
    expect(extractJudgeFailureReason(report)).toBeUndefined();
  });

  it('extracts the human-readable reason from the canonical buildEvaluatorErrorPatch(judge_failed) shape', () => {
    const report = {
      status: 'completed',
      metricsStatus: 'error',
      traceError:
        'Judge evaluation failed (kind=judge_failed): Bedrock Judge validation error (not retryable): ' +
        'The agent (trace) judge provider needs a runId or at least one trace correlation hint',
    };
    expect(extractJudgeFailureReason(report)).toBe(
      'Bedrock Judge validation error (not retryable): The agent (trace) judge provider needs a runId or at least one trace correlation hint'
    );
  });

  it('extracts the reason from the legacy pre-fix shape (status: failed, llmJudgeReasoning names the judge)', () => {
    const report = {
      status: 'failed',
      llmJudgeReasoning:
        'Evaluation failed: Bedrock Judge validation error (not retryable): The agent (trace) judge ' +
        'provider needs a runId or at least one trace correlation hint',
    };
    expect(extractJudgeFailureReason(report)).toBe(
      'Bedrock Judge validation error (not retryable): The agent (trace) judge provider needs a runId or at least one trace correlation hint'
    );
  });

  it('does NOT mislabel a legacy-shape agent/network failure (no mention of "judge") as a judge failure', () => {
    const report = {
      status: 'failed',
      llmJudgeReasoning: 'Evaluation failed: ECONNREFUSED connecting to https://example-agent.internal',
    };
    expect(extractJudgeFailureReason(report)).toBeUndefined();
  });

  it('is case-insensitive when matching "judge" in the legacy shape', () => {
    const report = { status: 'failed', llmJudgeReasoning: 'Evaluation failed: Judge model unavailable' };
    expect(extractJudgeFailureReason(report)).toBeDefined();
  });
});

describe('computeJudgeFailureSummary', () => {
  it('returns undefined when total is 0', () => {
    expect(computeJudgeFailureSummary([], 0)).toBeUndefined();
  });

  it('returns undefined when there are no judge failures', () => {
    expect(computeJudgeFailureSummary([undefined, undefined], 2)).toBeUndefined();
  });

  it('returns undefined when judge failures are a minority (<50%) of the total', () => {
    // 1 failure out of 3 planned cases -- an incidental failure, not dominant.
    const reasons = [undefined, undefined, 'Bedrock Judge validation error'];
    expect(computeJudgeFailureSummary(reasons, 3)).toBeUndefined();
  });

  it('surfaces a summary when judge failures are exactly half of the total', () => {
    const reasons = ['Bedrock Judge validation error', undefined];
    expect(computeJudgeFailureSummary(reasons, 2)).toBe(
      '1/2 case failed at the judge step: Bedrock Judge validation error'
    );
  });

  it('surfaces the reported-incident shape: all 62 cases failed at the judge step', () => {
    const reasons = Array.from({ length: 62 }, () => 'Bedrock Judge validation error (not retryable): needs a runId or trace correlation hint');
    const summary = computeJudgeFailureSummary(reasons, 62);
    expect(summary).toBe(
      '62/62 cases failed at the judge step: Bedrock Judge validation error (not retryable): needs a runId or trace correlation hint'
    );
  });

  it('picks the most frequent distinct reason when judge failures have mixed messages', () => {
    const reasons = [
      'reason A', 'reason A', 'reason A',
      'reason B',
      undefined,
    ];
    // 4/5 >= 50% -- dominant overall; "reason A" (3) beats "reason B" (1).
    expect(computeJudgeFailureSummary(reasons, 5)).toBe('4/5 cases failed at the judge step: reason A');
  });

  it('uses singular "case" for exactly one failure', () => {
    expect(computeJudgeFailureSummary(['only reason'], 1)).toBe('1/1 case failed at the judge step: only reason');
  });
});
