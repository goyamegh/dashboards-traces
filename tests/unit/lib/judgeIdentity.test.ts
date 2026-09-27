/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/judgeIdentity — "which judge KIND ran, and which LLM was behind it".
 *
 * Pins the contract every persistence path relies on:
 *   - a provider pseudo-id (`agent-trace-judge`) is never written as the
 *     underlying model;
 *   - a plain provider's configured id IS the model (trivial judgeModel);
 *   - the provider's resolved id always wins when present;
 *   - old reports (no judgeModel) are described as "model not recorded".
 */

import {
  isJudgeProviderPseudoModelId,
  resolveJudgeModelForReport,
  buildJudgeIdentityPatch,
  buildLlmJudgeResponseIdentity,
  describeJudgeModel,
  shortJudgeModelLabel,
  resolveJudgeIdentityFromMatchers,
  buildSdkJudgeIdentityPatch,
  findJudgeIdentityInconsistency,
  assertJudgeIdentityConsistent,
  inferJudgeProviderFromId,
  JUDGE_PROVIDER_NONE,
} from '@/lib/judgeIdentity';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

describe('isJudgeProviderPseudoModelId', () => {
  it('recognises the judge-kind ids that name a provider, not a model', () => {
    for (const id of ['agent-trace-judge', 'pi-judge', 'agentic-claude-code', 'agentic-custom', 'claude-code-judge']) {
      expect(isJudgeProviderPseudoModelId(id)).toBe(true);
    }
  });
  it('treats real model ids and empty values as non-pseudo', () => {
    expect(isJudgeProviderPseudoModelId('us.anthropic.claude-sonnet-4-6')).toBe(false);
    expect(isJudgeProviderPseudoModelId('claude-sonnet-4.6')).toBe(false);
    expect(isJudgeProviderPseudoModelId(undefined)).toBe(false);
    expect(isJudgeProviderPseudoModelId('')).toBe(false);
  });
});

describe('resolveJudgeModelForReport', () => {
  it('prefers the provider-resolved judgeModel (agent trace judge)', () => {
    expect(resolveJudgeModelForReport({ judgeModel: SONNET_45, judgeProvider: 'agent' }, 'agent-trace-judge')).toBe(SONNET_45);
  });
  it('falls back to the configured id for plain providers (bedrock: judgeModel == judgeModelId)', () => {
    expect(resolveJudgeModelForReport({}, 'us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolveJudgeModelForReport(undefined, 'us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
  });
  it('NEVER promotes a provider pseudo-id to judgeModel when nothing was resolved', () => {
    expect(resolveJudgeModelForReport({}, 'agent-trace-judge')).toBeUndefined();
    expect(resolveJudgeModelForReport(undefined, 'pi-judge')).toBeUndefined();
    expect(resolveJudgeModelForReport({ judgeModel: '   ' }, 'agent-trace-judge')).toBeUndefined();
  });
  it('returns undefined with no judge at all', () => {
    expect(resolveJudgeModelForReport(undefined, undefined)).toBeUndefined();
  });
});

describe('buildJudgeIdentityPatch', () => {
  it('emits { judgeModel, judgeProvider } when known and never an undefined key (no clobbering a merge)', () => {
    expect(buildJudgeIdentityPatch({ judgeModel: SONNET_45, judgeProvider: 'agent' }, 'agent-trace-judge'))
      .toEqual({ judgeModel: SONNET_45, judgeProvider: 'agent' });
    // Plain model id, provider not reported (old server): the model is the id; no provider key.
    expect(buildJudgeIdentityPatch({}, 'claude-sonnet-4.6')).toEqual({ judgeModel: 'claude-sonnet-4.6' });
    // Pseudo-id with no resolution: the kind is inferred, the model is NOT fabricated.
    const patch = buildJudgeIdentityPatch({}, 'agent-trace-judge');
    expect(patch).toEqual({ judgeProvider: 'agent' });
    expect('judgeModel' in patch).toBe(false);
    expect(buildJudgeIdentityPatch(undefined, undefined)).toEqual({});
  });
});

describe('inferJudgeProviderFromId', () => {
  it('maps provider pseudo-ids to their kind and leaves real model ids alone', () => {
    expect(inferJudgeProviderFromId('agent-trace-judge')).toBe('agent');
    expect(inferJudgeProviderFromId('pi-judge')).toBe('pi');
    expect(inferJudgeProviderFromId('claude-code-judge')).toBe('claude-code');
    expect(inferJudgeProviderFromId('agentic-custom')).toBe('agentic');
    expect(inferJudgeProviderFromId('us.anthropic.claude-sonnet-4-6')).toBeUndefined();
    expect(inferJudgeProviderFromId(undefined)).toBeUndefined();
  });
});

describe('resolveJudgeIdentityFromMatchers (code-SDK reports)', () => {
  const llm = (extra: Record<string, unknown> = {}) => ({ description: 'judge: claim', pass: true, method: 'llm-judge', role: 'gate', ...extra });

  it('rolls the FIRST resolved underlying LLM + its kind up from the judge() matchers', () => {
    const identity = resolveJudgeIdentityFromMatchers([
      { description: 'x to equal x', pass: true, method: 'code-assertion' },
      llm({ model: 'agent-trace-judge', judgeModel: SONNET_45, judgeProvider: 'agent' }),
      llm({ model: 'agent-trace-judge', judgeModel: 'amazon-bedrock/us.anthropic.claude-opus-4-6', judgeProvider: 'agent' }),
    ], 'agent-trace-judge');
    expect(identity).toEqual({ judgeModel: SONNET_45, judgeProvider: 'agent', judgeCallCount: 2 });
  });

  it('never accepts a provider pseudo-id as the model (old server echoing the requested id) but still infers the kind', () => {
    const identity = resolveJudgeIdentityFromMatchers([
      llm({ model: 'agent-trace-judge', judgeModel: 'agent-trace-judge' }),
    ], 'agent-trace-judge');
    expect(identity.judgeModel).toBeUndefined();
    expect(identity.judgeProvider).toBe('agent');
    expect(identity.judgeCallCount).toBe(1);
    // ...and falls back to the run's judgeModelId when the matcher recorded no model at all.
    expect(resolveJudgeIdentityFromMatchers([llm()], 'agent-trace-judge')).toEqual({ judgeProvider: 'agent', judgeCallCount: 1 });
  });

  it('a plain model id requested on an old server (no judgeModel in the response) IS the model', () => {
    expect(resolveJudgeIdentityFromMatchers([llm({ model: 'us.anthropic.claude-sonnet-4-6' })], undefined))
      .toEqual({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeCallCount: 1 });
    expect(resolveJudgeIdentityFromMatchers([llm({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' })], 'us.anthropic.claude-sonnet-4-6'))
      .toEqual({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock', judgeCallCount: 1 });
  });

  it("marks a body that made NO LLM judge call as judgeProvider 'none' (skipped / not-reached rows do not count)", () => {
    expect(resolveJudgeIdentityFromMatchers([
      { description: 'x', pass: true, method: 'code-assertion' },
      { description: 'traces.totalTokens < 10', pass: true, method: 'traces' },
      llm({ description: 'judge: claim (skipped)', skipped: true, role: 'observe' }),
      llm({ notReached: true, pass: false }),
    ], 'agent-trace-judge')).toEqual({ judgeProvider: JUDGE_PROVIDER_NONE, judgeCallCount: 0 });
    expect(resolveJudgeIdentityFromMatchers([], 'agent-trace-judge')).toEqual({ judgeProvider: JUDGE_PROVIDER_NONE, judgeCallCount: 0 });
    expect(resolveJudgeIdentityFromMatchers(undefined, undefined)).toEqual({ judgeProvider: JUDGE_PROVIDER_NONE, judgeCallCount: 0 });
  });

  it('errored judge calls count as calls but contribute no identity', () => {
    expect(resolveJudgeIdentityFromMatchers([
      llm({ errored: true, pass: false, model: 'agent-trace-judge' }),
    ], 'agent-trace-judge')).toEqual({ judgeCallCount: 1 });
    // an errored first call does not hide a later successful one
    expect(resolveJudgeIdentityFromMatchers([
      llm({ errored: true, pass: false }),
      llm({ judgeModel: SONNET_45, judgeProvider: 'agent' }),
    ], 'agent-trace-judge')).toEqual({ judgeModel: SONNET_45, judgeProvider: 'agent', judgeCallCount: 2 });
  });

  it('buildSdkJudgeIdentityPatch is the report patch form (no judgeCallCount, no undefined keys)', () => {
    expect(buildSdkJudgeIdentityPatch([llm({ judgeModel: SONNET_45, judgeProvider: 'agent' })], 'agent-trace-judge'))
      .toEqual({ judgeModel: SONNET_45, judgeProvider: 'agent' });
    expect(buildSdkJudgeIdentityPatch([{ description: 'x', pass: true, method: 'code-assertion' }], 'agent-trace-judge'))
      .toEqual({ judgeProvider: JUDGE_PROVIDER_NONE });
    const errored = buildSdkJudgeIdentityPatch([llm({ errored: true, pass: false })], undefined);
    expect(errored).toEqual({});
    expect('judgeModel' in errored).toBe(false);
  });
});

describe('judge identity runtime guard', () => {
  const okSdk = {
    id: 'r1', judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45, judgeProvider: 'agent',
    matcherResults: [{ description: 'judge: c', pass: true, method: 'llm-judge', judgeModel: SONNET_45 }],
  };

  it('is silent for consistent reports (classic, SDK with a model, deterministic-only, all-errored, old report with no judge at all)', () => {
    expect(findJudgeIdentityInconsistency(okSdk)).toBeUndefined();
    expect(findJudgeIdentityInconsistency({ id: 'r2', judgeModelId: 'us.anthropic.claude-sonnet-4-6', judgeModel: 'us.anthropic.claude-sonnet-4-6', llmJudgeResponse: { modelId: 'us.anthropic.claude-sonnet-4-6' } })).toBeUndefined();
    expect(findJudgeIdentityInconsistency({ id: 'r3', judgeModelId: 'agent-trace-judge', judgeProvider: JUDGE_PROVIDER_NONE, matcherResults: [{ description: 'x', pass: true, method: 'code-assertion' }] })).toBeUndefined();
    expect(findJudgeIdentityInconsistency({ id: 'r4', matcherResults: [{ description: 'judge: c', pass: false, method: 'llm-judge', errored: true }] })).toBeUndefined();
    expect(findJudgeIdentityInconsistency({ id: 'r5', judgeModelId: 'agent-trace-judge' })).toBeUndefined();
    expect(findJudgeIdentityInconsistency(undefined)).toBeUndefined();
  });

  it('flags an LLM judge that ran without a resolved model -- the exact miss this guards against', () => {
    // SDK path: judge() matcher recorded, nothing rolled up (pre-fix shape).
    expect(findJudgeIdentityInconsistency({
      id: 'sdk-miss', judgeModelId: 'agent-trace-judge',
      matcherResults: [{ description: 'judge: 2 claims', pass: true, method: 'llm-judge', model: 'agent-trace-judge' }],
    })).toMatch(/1 llm-judge matcher\(s\)\) but no resolved judgeModel was recorded \(judgeModelId: agent-trace-judge\)/);
    // Classic path: llmJudgeResponse present, judgeModel absent.
    expect(findJudgeIdentityInconsistency({ id: 'classic-miss', llmJudgeResponse: { modelId: 'agent-trace-judge' } }))
      .toMatch(/llmJudgeResponse\) but no resolved judgeModel/);
  });

  it('flags a provider pseudo-id written as the model, and a none-marker on a judged report', () => {
    expect(findJudgeIdentityInconsistency({ ...okSdk, judgeModel: 'agent-trace-judge' })).toMatch(/pseudo-id/);
    expect(findJudgeIdentityInconsistency({ id: 'x', judgeModel: 'pi-judge' })).toMatch(/pseudo-id/);
    expect(findJudgeIdentityInconsistency({ ...okSdk, judgeProvider: JUDGE_PROVIDER_NONE })).toMatch(/'none' although an LLM judge ran/);
  });

  it('assertJudgeIdentityConsistent logs "[JudgeIdentity] WARN <id>: …" and NEVER throws', () => {
    const log = jest.fn();
    expect(assertJudgeIdentityConsistent(okSdk, log)).toBe(true);
    expect(log).not.toHaveBeenCalled();

    expect(assertJudgeIdentityConsistent({ id: 'sdk-miss', matcherResults: [{ description: 'j', pass: true, method: 'llm-judge' }] }, log)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[JudgeIdentity\] WARN sdk-miss: an LLM judge ran/);

    // unsaved report (no id) + a logger that throws: still returns, still no throw
    const throwing = jest.fn(() => { throw new Error('logger down'); });
    expect(() => assertJudgeIdentityConsistent({ llmJudgeResponse: { modelId: 'x' } }, throwing)).not.toThrow();
    expect(throwing.mock.calls[0][0]).toMatch(/\(unsaved report\)/);

    // default logger is console.warn
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    assertJudgeIdentityConsistent({ id: 'w', llmJudgeResponse: { modelId: 'x' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[JudgeIdentity] WARN w:'));
    warn.mockRestore();
  });
});

describe('buildLlmJudgeResponseIdentity', () => {
  it('puts the REAL model on modelId and keeps the provider kind (agent trace judge)', () => {
    expect(buildLlmJudgeResponseIdentity({ judgeModel: SONNET_45, judgeProvider: 'agent' }, 'agent-trace-judge'))
      .toEqual({ modelId: SONNET_45, judgeProvider: 'agent' });
  });
  it('infers the provider kind from a pseudo-id when the service did not say (older /api/judge)', () => {
    expect(buildLlmJudgeResponseIdentity({}, 'agent-trace-judge')).toEqual({ modelId: 'agent-trace-judge', judgeProvider: 'agent' });
    expect(buildLlmJudgeResponseIdentity({}, 'pi-judge')).toEqual({ modelId: 'pi-judge', judgeProvider: 'pi' });
    expect(buildLlmJudgeResponseIdentity({}, 'agentic-claude-code')).toEqual({ modelId: 'agentic-claude-code', judgeProvider: 'agentic' });
  });
  it('bedrock: modelId is the configured id, provider from the service', () => {
    expect(buildLlmJudgeResponseIdentity({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' }, 'us.anthropic.claude-sonnet-4-6'))
      .toEqual({ modelId: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' });
    expect(buildLlmJudgeResponseIdentity(undefined, 'us.anthropic.claude-sonnet-4-6')).toEqual({ modelId: 'us.anthropic.claude-sonnet-4-6' });
  });
  it('never yields an empty-string modelId when a configured id exists; empty only when nothing is known', () => {
    expect(buildLlmJudgeResponseIdentity(undefined, undefined).modelId).toBe('');
  });
});

describe('describeJudgeModel', () => {
  it('flags an agentic judge with no recorded model as modelNotRecorded (old reports)', () => {
    expect(describeJudgeModel({ judgeModelId: 'agent-trace-judge' })).toEqual({
      judgeModelId: 'agent-trace-judge', judgeModel: undefined, modelNotRecorded: true, noLlmJudge: false,
    });
  });
  it("reports noLlmJudge for a code-SDK report/run whose judgeProvider is 'none' (and does not call that 'not recorded')", () => {
    const d = describeJudgeModel({ judgeModelId: 'agent-trace-judge', judgeProvider: JUDGE_PROVIDER_NONE });
    expect(d.noLlmJudge).toBe(true);
    expect(d.modelNotRecorded).toBe(false);
    // a recorded model always wins over a stale 'none' marker
    expect(describeJudgeModel({ judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45, judgeProvider: JUDGE_PROVIDER_NONE }).noLlmJudge).toBe(false);
  });
  it('does not flag when the model IS recorded, or when the judge is a plain model id', () => {
    expect(describeJudgeModel({ judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45 }).modelNotRecorded).toBe(false);
    expect(describeJudgeModel({ judgeModelId: 'us.anthropic.claude-sonnet-4-6' }).modelNotRecorded).toBe(false);
    expect(describeJudgeModel(undefined).modelNotRecorded).toBe(false);
  });
});

describe('shortJudgeModelLabel', () => {
  it('reduces a provider-qualified Bedrock profile id to the Claude family+version', () => {
    expect(shortJudgeModelLabel(SONNET_45)).toBe('claude-sonnet-4-5');
    expect(shortJudgeModelLabel('amazon-bedrock/us.anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(shortJudgeModelLabel('anthropic/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
  });
  it('strips only the provider prefix for non-Claude ids', () => {
    expect(shortJudgeModelLabel('openai/gpt-4o')).toBe('gpt-4o');
    expect(shortJudgeModelLabel('gpt-4o')).toBe('gpt-4o');
  });
});
