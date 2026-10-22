/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-error surfacing — the failure-stage additions across the evaluator
 * error patch, retry-judgement eligibility, the judge-failure summary and the
 * read helpers the UI uses.
 */

import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { describeAgentError } from '@/services/evaluation/agentFailure';
import { isJudgeFailedCase, hasRejudgeableOutput } from '@/services/evaluation/retryJudgement';
import { extractJudgeFailureReason } from '@/lib/judgeFailureSummary';
import { getFailureStage, agentProducedNoOutput, describeAgentErrorKind, formatMs } from '@/lib/reportFailure';

function undiciHeadersTimeout(): Error {
  const cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('buildEvaluatorErrorPatch — failureStage + structured detail', () => {
  it('maps every kind to a stage', () => {
    expect(buildEvaluatorErrorPatch('agent_failed', 'x').failureStage).toBe('agent');
    expect(buildEvaluatorErrorPatch('judge_failed', 'x').failureStage).toBe('judge');
    for (const k of ['trace_timeout', 'trace_incomplete', 'trace_callback_failed', 'trace_fetch_failed'] as const) {
      expect(buildEvaluatorErrorPatch(k, 'x').failureStage).toBe('trace');
    }
    expect(buildEvaluatorErrorPatch('unknown', 'x').failureStage).toBe('judge');
  });

  it('agent_failed: stamps failureStage:"agent", the unwrapped cause as `error`, agentError, and agent-stage prose', () => {
    const err = undiciHeadersTimeout();
    const agentError = describeAgentError(err, { endpoint: 'http://localhost:8000/ask', elapsedMs: 300_700 });
    const patch = buildEvaluatorErrorPatch('agent_failed', err, agentError);
    expect(patch.metricsStatus).toBe('error');
    expect(patch.failureStage).toBe('agent');
    expect(patch.passFailStatus).toBeNull();
    expect(patch.agentError).toEqual(agentError);
    // The recorded cause is the REAL one, not the opaque wrapper.
    expect(patch.error).toMatch(/HeadersTimeoutError/);
    expect(patch.error).not.toMatch(/fetch failed/);
    expect(patch.traceError).toMatch(/^Agent request failed \(kind=agent_failed\): .*HeadersTimeoutError/);
    expect(patch.llmJudgeReasoning).toMatch(/Agent request failed — not judged/);
    expect(patch.llmJudgeReasoning).toMatch(/re-run the case/);
    expect(patch.llmJudgeReasoning).not.toMatch(/Evaluator could not run/);
  });

  it('judge_failed / trace_* keep the evaluator prose and carry no agentError', () => {
    const judge = buildEvaluatorErrorPatch('judge_failed', new Error('empty reply'));
    expect(judge.failureStage).toBe('judge');
    expect(judge.error).toBe('empty reply');
    expect(judge.llmJudgeReasoning).toMatch(/Evaluator could not run/);
    expect(judge.agentError).toBeUndefined();
    const trace = buildEvaluatorErrorPatch('trace_timeout', 'polling exhausted');
    expect(trace.failureStage).toBe('trace');
    expect(trace.error).toBe('polling exhausted');
    expect(trace.agentError).toBeUndefined();
  });
});

describe('retry-judgement + judgeFailureSummary exclude agent-stage failures', () => {
  const agentFailed = {
    status: 'failed', metricsStatus: 'error', failureStage: 'agent',
    traceError: 'Agent request failed (kind=agent_failed): HeadersTimeoutError', trajectory: [], rawEvents: [],
  } as any;
  it('isJudgeFailedCase / hasRejudgeableOutput are false even when the run result says completed and output exists', () => {
    expect(isJudgeFailedCase(agentFailed, { reportId: 'r', status: 'completed' })).toBe(false);
    expect(hasRejudgeableOutput({ ...agentFailed, trajectory: [{ id: 'x' }] })).toBe(false);
    // A judge-stage failure with output is still re-judgeable.
    const judgeFailed = { ...agentFailed, status: 'completed', failureStage: 'judge', traceError: 'Judge evaluation failed (kind=judge_failed): x', trajectory: [{ id: 'x' }] };
    expect(isJudgeFailedCase(judgeFailed, { reportId: 'r', status: 'completed' })).toBe(true);
  });
  it('extractJudgeFailureReason is undefined for an agent-stage report (does not inflate judgeFailureSummary)', () => {
    expect(extractJudgeFailureReason(agentFailed)).toBeUndefined();
    // Judge-stage still recognized.
    expect(extractJudgeFailureReason({ status: 'completed', metricsStatus: 'error', failureStage: 'judge', traceError: 'Judge evaluation failed (kind=judge_failed): empty reply' })).toBe('empty reply');
  });
});

describe('lib/reportFailure', () => {
  it('getFailureStage reads only the explicit marker', () => {
    expect(getFailureStage({ failureStage: 'agent' })).toBe('agent');
    expect(getFailureStage({ failureStage: 'judge' })).toBe('judge');
    expect(getFailureStage({ failureStage: 'bogus' as any })).toBeUndefined();
    expect(getFailureStage({})).toBeUndefined();
    expect(getFailureStage(null)).toBeUndefined();
  });
  it('helpers', () => {
    expect(agentProducedNoOutput({ trajectory: [], rawEvents: [] } as any)).toBe(true);
    expect(agentProducedNoOutput({ trajectory: [{}], rawEvents: [] } as any)).toBe(false);
    expect(describeAgentErrorKind('timeout')).toBe('agent request timed out');
    expect(describeAgentErrorKind('connection')).toBe('could not connect to the agent');
    expect(describeAgentErrorKind('http_503')).toBe('agent returned HTTP 503');
    expect(describeAgentErrorKind('unknown')).toBe('no response');
    expect(describeAgentErrorKind(undefined)).toBe('no response');
    expect(formatMs(500)).toBe('500 ms');
    expect(formatMs(2500)).toBe('2.5 s');
    expect(formatMs(300_728)).toBe('5 min 1 s');
    expect(formatMs(300_000)).toBe('5 min');
    expect(formatMs(undefined)).toBeUndefined();
  });
});
