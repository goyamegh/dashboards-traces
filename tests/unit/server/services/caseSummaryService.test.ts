/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the case TL;DR service (server/services/caseSummaryService.ts):
 *
 *   - inputs builder: bounded fields, verdict / not-judged classification
 *     for pass, fail, agent error, judge error, pending;
 *   - deterministic fallback: three sentences, honest about errors ("not
 *     judged"), never a fake verdict;
 *   - cache: same inputs → cached summary reused (no model call); a changed
 *     judgement (re-judge) → hash mismatch → regenerated and persisted;
 *     fallback results are never persisted;
 *   - model failure / timeout → fallback with the error attached;
 *   - parser tolerance (fences, trailing commas);
 *   - credential wiring: the Bedrock client is built with the refreshing
 *     credential provider (repo rule, #569).
 */

const mockSend = jest.fn();
const mockClientCtor = jest.fn();
const mockCredentialProvider = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn((cfg: any) => {
    mockClientCtor(cfg);
    return { send: mockSend };
  }),
  ConverseCommand: jest.fn((input: any) => ({ input })),
}));

jest.mock('@/lib/aws/refreshingCredentialProvider', () => ({
  createRefreshingCredentialProvider: jest.fn(() => mockCredentialProvider),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

jest.mock('@/lib/bedrockCompat', () => {
  const actual = jest.requireActual('@/lib/bedrockCompat');
  return { ...actual, resolveRegionAwareModelId: jest.fn((id: string) => actual.resolveRegionAwareModelId(id)) };
});

import {
  buildCaseSummaryInputs,
  buildFallbackSummary,
  buildFallbackSummaryParts,
  buildCaseSummaryPrompt,
  composeVerdict,
  hashCaseSummaryInputs,
  isCaseSummaryCurrent,
  parseCaseSummaryResponse,
  generateCaseSummary,
  truncateForSummary,
  CASE_SUMMARY_LIMITS,
  _resetCaseSummaryClient,
  _resetCaseSummaryThrottle,
  isCaseSummaryModelEnabled,
  getMaxConcurrentGenerations,
} from '@/server/services/caseSummaryService';
import { createRefreshingCredentialProvider } from '@/lib/aws/refreshingCredentialProvider';
import type { TestCase, TestCaseRun } from '@/types';

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'checkout 500s root cause',
    description: '',
    labels: [],
    category: 'Test' as any,
    difficulty: 'Easy' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    context: [],
    initialPrompt: 'Our checkout service returns HTTP 500 for 2% of requests since the 14:00 deploy. Find the root cause.',
    expectedOutcomes: ['Identifies the null pointer in the discount handler', 'Recommends a rollback or hot-fix'],
    ...overrides,
  } as TestCase;
}

function passedReport(overrides: Partial<TestCaseRun> = {}): TestCaseRun {
  return {
    id: 'report-1',
    timestamp: '2026-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    agentName: 'Ops RCA agent',
    modelName: 'demo-model',
    status: 'completed',
    metricsStatus: 'ready',
    passFailStatus: 'passed',
    score: 0.9,
    trajectory: [
      { id: 's1', type: 'action', toolName: 'search_logs', toolArgs: { q: 'status:500' }, timestamp: 1 } as any,
      { id: 's2', type: 'tool_result', content: '412 hits; NullPointerException in DiscountCodeHandler', timestamp: 2 } as any,
      { id: 's3', type: 'action', toolName: 'get_deployments', timestamp: 3 } as any,
      { id: 's4', type: 'response', content: 'Root cause: build 8812 introduced a null dereference in DiscountCodeHandler. Recommend rollback.', timestamp: 4 } as any,
    ],
    metrics: { accuracy: 92, faithfulness: 90, latency_score: 85, trajectory_alignment_score: 88 } as any,
    llmJudgeReasoning: 'The agent traced the 500s to the NullPointerException introduced by build 8812 and recommended a rollback. Minor: no exact start time.',
    ...overrides,
  } as TestCaseRun;
}

const agentErrorCause = 'Agent request timed out after 300728ms (timeout 300000ms) — no response headers/body';
function agentErrorReport(): TestCaseRun {
  return passedReport({
    status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: undefined, score: undefined,
    trajectory: [], rawEvents: [],
    error: agentErrorCause,
    agentError: { kind: 'timeout', message: agentErrorCause, elapsedMs: 300_728, timeoutMs: 300_000 } as any,
    llmJudgeReasoning: '**Agent request failed — not judged.**',
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 } as any,
  });
}

function judgeErrorReport(): TestCaseRun {
  return passedReport({
    status: 'completed', metricsStatus: 'error', failureStage: 'judge', passFailStatus: undefined, score: undefined,
    error: 'Bedrock Judge evaluation failed after 2 attempts: judge returned no parseable verdict',
    judgeError: { message: 'judge returned no parseable verdict', rawResponse: '', attempts: 2 },
    llmJudgeReasoning: '**Evaluator could not run.**',
  });
}

/** Code-SDK shape: verdict from code assertions, no LLM judge at all. */
function codeSdkReport(overrides: Partial<TestCaseRun> = {}): TestCaseRun {
  return passedReport({
    passFailStatus: 'failed', score: undefined, llmJudgeReasoning: '', judgeProvider: 'none', judgeModelId: 'agent-trace-judge',
    matcherResults: [
      { description: "[ …(3) ] to include 'doc-a'", pass: true, method: 'code-assertion', actual: ['doc-a'] } as any,
      { description: 'result to have called tool search', pass: false, method: 'code-assertion', errorMessage: 'expected search, got none' } as any,
    ],
    ...overrides,
  });
}

function llmReply(reply: { asked: string; agent: string; why: string }, wrap = (s: string) => s) {
  return { output: { message: { content: [{ text: wrap(JSON.stringify(reply)) }] } } };
}

const GOOD_REPLY = {
  asked: 'The test asked the agent to find why checkout returns 500s since the 14:00 deploy.',
  agent: 'The agent searched logs and deployments, found the null dereference in DiscountCodeHandler and recommended a rollback.',
  why: 'both expected outcomes were met and the rollback target was correct',
};
/** What the stored parts look like for GOOD_REPLY on the passed report (verdict label is composed server-side). */
const GOOD_PARTS = {
  asked: GOOD_REPLY.asked,
  agent: GOOD_REPLY.agent,
  verdict: 'Judge verdict: PASSED (score 90%) — both expected outcomes were met and the rollback target was correct.',
};

describe('caseSummaryService — inputs builder', () => {
  it('bounds long fields and collects tools, final answer and judgement for a passed report', () => {
    const longPrompt = 'x'.repeat(5000);
    const inputs = buildCaseSummaryInputs(passedReport(), testCase({ initialPrompt: longPrompt }));
    expect(inputs.prompt.length).toBeLessThanOrEqual(CASE_SUMMARY_LIMITS.prompt);
    expect(inputs.prompt.endsWith('…')).toBe(true);
    expect(inputs.toolsUsed).toEqual(['search_logs', 'get_deployments']);
    expect(inputs.stepCount).toBe(4);
    expect(inputs.finalAnswer).toContain('build 8812');
    expect(inputs.verdict).toBe('passed');
    expect(inputs.score).toBe(0.9);
    expect(inputs.reasoning).toContain('NullPointerException');
    expect(inputs.notJudged).toBeUndefined();
  });

  it('classifies an agent error as not judged with the agent stage + cause (no verdict, no reasoning)', () => {
    const inputs = buildCaseSummaryInputs(agentErrorReport(), testCase());
    expect(inputs.verdict).toBe('not_judged');
    expect(inputs.notJudged?.stage).toBe('agent');
    expect(inputs.notJudged?.cause).toContain('timed out');
    expect(inputs.reasoning).toBe('');
    expect(inputs.finalAnswer).toBe('');
  });

  it('classifies a judge error as not judged with the judge stage', () => {
    const inputs = buildCaseSummaryInputs(judgeErrorReport(), testCase());
    expect(inputs.verdict).toBe('not_judged');
    expect(inputs.notJudged?.stage).toBe('judge');
    expect(inputs.notJudged?.cause).toContain('no parseable verdict');
  });

  it('classifies a pending judgement as not judged yet', () => {
    const inputs = buildCaseSummaryInputs(passedReport({ metricsStatus: 'calculating', passFailStatus: undefined }), testCase());
    expect(inputs.verdict).toBe('not_judged');
    expect(inputs.notJudged).toEqual({ stage: 'pending', cause: 'judgement in progress' });
  });

  it('summarises the test-case VERSION the report ran against, not the edited current one', () => {
    const tc = testCase({
      initialPrompt: 'new prompt',
      expectedOutcomes: ['new outcome'],
      currentVersion: 2,
      versions: [
        { version: 1, createdAt: '', initialPrompt: 'old prompt', expectedOutcomes: ['old outcome'], context: [] } as any,
        { version: 2, createdAt: '', initialPrompt: 'new prompt', expectedOutcomes: ['new outcome'], context: [] } as any,
      ],
    });
    const ranV1 = buildCaseSummaryInputs(passedReport({ testCaseVersion: 1 }), tc);
    expect(ranV1.prompt).toBe('old prompt');
    expect(ranV1.expectedOutcomes).toEqual(['old outcome']);
    // No version on the report (older runs) → current content.
    const unknown = buildCaseSummaryInputs(passedReport(), tc);
    expect(unknown.prompt).toBe('new prompt');
    expect(unknown.expectedOutcomes).toEqual(['new outcome']);
    // Different content → different cache key.
    expect(hashCaseSummaryInputs(ranV1)).not.toBe(hashCaseSummaryInputs(unknown));
  });

  it('final answer is the last response/assistant step — never a tool result or thinking', () => {
    const inputs = buildCaseSummaryInputs(passedReport({
      trajectory: [
        { id: 's1', type: 'response', content: 'Early draft answer.', timestamp: 1 } as any,
        { id: 's2', type: 'thinking', content: 'Let me double check…', timestamp: 2 } as any,
        { id: 's3', type: 'tool_result', content: 'raw tool payload', timestamp: 3 } as any,
      ],
    }), testCase());
    expect(inputs.finalAnswer).toBe('Early draft answer.');
    expect(buildCaseSummaryInputs(passedReport({ trajectory: [{ id: 's1', type: 'tool_result', content: 'only a tool result', timestamp: 1 } as any] }), testCase()).finalAnswer).toBe('');
  });

  it('the fingerprint notices changes beyond the truncation boundary and re-judges that reproduce the same text', () => {
    const tc = testCase();
    const base = passedReport({ llmJudgeReasoning: 'x'.repeat(3000) });
    const changedPastLimit = passedReport({ llmJudgeReasoning: 'x'.repeat(2999) + 'y' });
    const a = buildCaseSummaryInputs(base, tc);
    const b = buildCaseSummaryInputs(changedPastLimit, tc);
    expect(a.reasoning).toBe(b.reasoning); // truncated copies are identical…
    expect(hashCaseSummaryInputs(a)).not.toBe(hashCaseSummaryInputs(b)); // …the cache key still differs
    const retried = buildCaseSummaryInputs(passedReport({ judgementRetriedAt: '2026-02-01T00:00:00Z', judgementRetryCount: 1 }), tc);
    expect(hashCaseSummaryInputs(retried)).not.toBe(hashCaseSummaryInputs(buildCaseSummaryInputs(passedReport(), tc)));
  });

  it('bounds every short field (names, tools, model ids) too', () => {
    const inputs = buildCaseSummaryInputs(passedReport({
      agentName: 'A'.repeat(1000),
      judgeModel: 'M'.repeat(1000),
      trajectory: [{ id: 's1', type: 'action', toolName: 'T'.repeat(1000), timestamp: 1 } as any],
    }), testCase({ name: 'N'.repeat(1000) }));
    for (const v of [inputs.agentName, inputs.judgeModel!, inputs.toolsUsed[0], inputs.testCaseName]) {
      expect(v.length).toBeLessThanOrEqual(CASE_SUMMARY_LIMITS.short);
    }
  });

  it('collects per-check verdicts from matcherResults and drops the judge model for judge-less code-SDK reports', () => {
    const inputs = buildCaseSummaryInputs(codeSdkReport(), testCase());
    // Failures first, so a truncated list keeps the "why".
    expect(inputs.checks).toEqual([
      { description: 'result to have called tool search', pass: false, method: 'code-assertion', errorMessage: 'expected search, got none' },
      { description: "[ …(3) ] to include 'doc-a'", pass: true, method: 'code-assertion' },
    ]);
    expect(inputs.checksTotal).toEqual({ total: 2, passed: 1, failed: 1, errored: 0 });
    expect(inputs.judgeModel).toBeUndefined();
    expect(inputs.reasoning).toBe('');
  });

  it('truncateForSummary collapses whitespace and appends an ellipsis', () => {
    expect(truncateForSummary('  a   b\n\nc ', 100)).toBe('a b c');
    expect(truncateForSummary('abcdefgh', 5)).toBe('abcd…');
    expect(truncateForSummary(undefined, 5)).toBe('');
  });
});

describe('caseSummaryService — deterministic fallback', () => {
  it('writes three sentences for a passed report: prompt, tools + answer, verdict + first reason', () => {
    const parts = buildFallbackSummaryParts(buildCaseSummaryInputs(passedReport(), testCase()));
    expect(parts.asked).toMatch(/^The test asks: “Our checkout service/);
    expect(parts.asked).toMatch(/It has 2 expected outcomes, e\.g\. “Identifies the null pointer in the discount handler”\./);
    expect(parts.agent).toMatch(/^Ops RCA agent used tools search_logs, get_deployments and answered: “Root cause: build 8812/);
    expect(parts.verdict).toMatch(/^Judge verdict: PASSED \(score 90%\) — The agent traced the 500s/);
    // Each part ends with punctuation.
    for (const s of Object.values(parts)) expect(s).toMatch(/[.!?…”]$/);
  });

  it('says "not judged" for an agent error — never a pass/fail, never zeros', () => {
    const parts = buildFallbackSummaryParts(buildCaseSummaryInputs(agentErrorReport(), testCase()));
    expect(parts.agent).toBe('Ops RCA agent produced no output.');
    expect(parts.verdict).toMatch(/^Not judged: the agent request failed — Agent request timed out/);
    expect(parts.verdict).not.toMatch(/PASSED|FAILED|score 0/);
  });

  it('says "not judged" for a judge error, naming the judge stage', () => {
    const parts = buildFallbackSummaryParts(buildCaseSummaryInputs(judgeErrorReport(), testCase()));
    expect(parts.verdict).toMatch(/^Not judged: the judge could not produce a verdict — /);
    expect(parts.agent).toContain('answered: “Root cause');
  });

  it('code-SDK report with no judge reasoning: the verdict sentence explains itself from the checks', () => {
    const failed = buildFallbackSummaryParts(buildCaseSummaryInputs(codeSdkReport(), testCase()));
    expect(failed.verdict).toBe("Verdict: FAILED — 1 failed of 2 checks, e.g. result to have called tool search.");
    const passed = buildFallbackSummaryParts(buildCaseSummaryInputs(codeSdkReport({
      passFailStatus: 'passed',
      matcherResults: [{ description: "[ …(3) ] to include 'doc-a'", pass: true, method: 'code-assertion' } as any],
    }), testCase()));
    expect(passed.verdict).toBe("Verdict: PASSED — all 1 check passed ([ …(3) ] to include 'doc-a').");
  });

  it('never says "all checks passed" when the list was truncated and a later check failed or errored', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ description: `check ${i}`, pass: true, method: 'code-assertion' }));
    many[11] = { description: 'check 11', pass: false, method: 'code-assertion' };
    const errored = buildFallbackSummaryParts(buildCaseSummaryInputs(codeSdkReport({
      matcherResults: [...many, { description: 'trace check', pass: false, errored: true, method: 'trace-check', errorMessage: 'no spans' }] as any,
    }), testCase()));
    expect(errored.verdict).toBe('Verdict: FAILED — 1 failed, 1 errored of 13 checks, e.g. check 11.');
    expect(errored.verdict).not.toMatch(/all .* passed/);
  });

  it('composeVerdict: the label always comes from the report; the model only supplies the reason', () => {
    const passed = buildCaseSummaryInputs(passedReport(), testCase());
    expect(composeVerdict(passed, 'FAILED because it did nothing right.')).toBe('Judge verdict: PASSED (score 90%) — FAILED because it did nothing right.');
    // (…the wrong word can appear in the reason, but the label is authoritative and first.)
    expect(composeVerdict(buildCaseSummaryInputs(agentErrorReport(), testCase()), 'PASSED with flying colours')).toMatch(/^Not judged: the agent request failed — Agent request timed out/);
    expect(composeVerdict(buildCaseSummaryInputs(judgeErrorReport(), testCase()), '')).toMatch(/^Not judged: the judge could not produce a verdict/);
  });

  it('attaches the model error and marks source=fallback', () => {
    const s = buildFallbackSummary(buildCaseSummaryInputs(passedReport(), testCase()), 'boom');
    expect(s.source).toBe('fallback');
    expect(s.error).toBe('boom');
    expect(s.inputsHash).toHaveLength(16);
  });
});

describe('caseSummaryService — prompt + parser', () => {
  it('prompt carries the bounded fields and tells the model when the run was not judged', () => {
    const judged = buildCaseSummaryPrompt(buildCaseSummaryInputs(passedReport(), testCase()));
    expect(judged).toContain('its verdict (PASSED)');
    expect(judged).toContain('"final_answer": "Root cause: build 8812');
    expect(judged).toContain('"tools_used": [\n  "search_logs",\n  "get_deployments"\n ]');
    // Untrusted content is fenced as data, and the system prompt says so.
    expect(judged).toContain('DATA (untrusted, JSON):');
    const notJudged = buildCaseSummaryPrompt(buildCaseSummaryInputs(agentErrorReport(), testCase()));
    expect(notJudged).toContain('this run was NOT judged');
    expect(notJudged).toContain('"not_judged_reason": "stage=agent;');
    expect(notJudged).not.toContain('judge_reasoning');
    const code = buildCaseSummaryPrompt(buildCaseSummaryInputs(codeSdkReport(), testCase()));
    expect(code).toContain('"checks_total": {\n  "total": 2,\n  "passed": 1,\n  "failed": 1,\n  "errored": 0\n }');
    expect(code).toContain('[FAIL] (code-assertion) result to have called tool search — expected search, got none');
    expect(code).not.toContain('judge_model');
    expect(code).not.toContain('checks_note');
    const truncated = buildCaseSummaryPrompt(buildCaseSummaryInputs(codeSdkReport({
      matcherResults: Array.from({ length: 20 }, (_, i) => ({ description: `c${i}`, pass: true, method: 'code-assertion' })) as any,
    }), testCase()));
    expect(truncated).toContain('only 8 of 20 checks listed');
  });

  it('parses plain JSON, fenced JSON, JSON with prose around it, and trailing commas', () => {
    const json = JSON.stringify(GOOD_REPLY);
    expect(parseCaseSummaryResponse(json)).toEqual(GOOD_REPLY);
    expect(parseCaseSummaryResponse('```json\n' + json + '\n```')).toEqual(GOOD_REPLY);
    expect(parseCaseSummaryResponse('Here you go:\n' + json + '\nHope this helps.')).toEqual(GOOD_REPLY);
    expect(parseCaseSummaryResponse(json.replace(/}$/, ',\n}'))).toEqual(GOOD_REPLY);
  });

  it('caps each part to one line of bounded length', () => {
    const long = { asked: 'a\n\nb   c ' + 'x'.repeat(2000), agent: 'ok', why: 'fine' };
    const parsed = parseCaseSummaryResponse(JSON.stringify(long));
    expect(parsed.asked.startsWith('a b c xxx')).toBe(true);
    expect(parsed.asked.length).toBeLessThanOrEqual(CASE_SUMMARY_LIMITS.part);
  });

  it('rejects replies without the three keys, non-objects and broken JSON (no regex guessing)', () => {
    expect(() => parseCaseSummaryResponse('no json here')).toThrow(/no JSON object/);
    expect(() => parseCaseSummaryResponse('{"asked": "a"}')).toThrow(/missing asked\/agent\/why/);
    expect(() => parseCaseSummaryResponse('{"asked": "He said "hi"", "agent": "x", "why": "y"}')).toThrow();
    expect(() => parseCaseSummaryResponse('{"asked": "a", "agent": ["b"], "why": "c"}')).toThrow(/missing asked\/agent\/why/);
  });
});

describe('caseSummaryService — generateCaseSummary (cache, invalidation, failures)', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    _resetCaseSummaryClient();
    _resetCaseSummaryThrottle();
    process.env = { ...ENV };
    delete process.env.CASE_SUMMARY_ENABLED;
    delete process.env.CASE_SUMMARY_MAX_CONCURRENT;
  });
  afterAll(() => { process.env = { ...ENV }; });

  it('calls the model once, persists the summary with the inputs hash, and reuses it while inputs are unchanged', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const persist = jest.fn().mockResolvedValue(undefined);
    const report = passedReport();
    const tc = testCase();

    const first = await generateCaseSummary(report, tc, { persist });
    expect(first.cached).toBe(false);
    expect(first.summary.source).toBe('llm');
    expect(first.summary.parts).toEqual(GOOD_PARTS);
    expect(first.summary.inputsHash).toBe(hashCaseSummaryInputs(buildCaseSummaryInputs(report, tc)));
    expect(persist).toHaveBeenCalledWith(first.summary);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Second view: the report now carries the cached summary → no model call.
    const second = await generateCaseSummary({ ...report, caseSummary: first.summary }, tc, { persist });
    expect(second.cached).toBe(true);
    expect(second.summary).toEqual(first.summary);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the judgement changed (re-judge) even though a summary is cached', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const tc = testCase();
    const report = passedReport();
    const { summary } = await generateCaseSummary(report, tc, {});

    const rejudged = {
      ...report,
      caseSummary: summary,
      passFailStatus: 'failed' as const,
      llmJudgeReasoning: 'Recommended rolling back to the wrong build.',
      judgementRetriedAt: '2026-01-02T00:00:00Z',
    };
    expect(isCaseSummaryCurrent(summary, buildCaseSummaryInputs(rejudged, tc))).toBe(false);

    mockSend.mockResolvedValueOnce(llmReply({ ...GOOD_REPLY, why: 'the rollback target was wrong' }));
    const persist = jest.fn().mockResolvedValue(undefined);
    const again = await generateCaseSummary(rejudged, tc, { persist });
    expect(again.cached).toBe(false);
    expect(again.summary.parts.verdict).toBe('Judge verdict: FAILED (score 90%) — the rollback target was wrong.');
    expect(again.summary.inputsHash).not.toBe(summary.inputsHash);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent generations for the same report + inputs into ONE model call', async () => {
    let resolveSend!: (v: any) => void;
    mockSend.mockImplementationOnce(() => new Promise((r) => { resolveSend = r; }));
    const persist = jest.fn().mockResolvedValue(undefined);
    const report = passedReport();
    const a = generateCaseSummary(report, testCase(), { persist });
    const b = generateCaseSummary(report, testCase(), { persist });
    // A different report must NOT be coalesced with them.
    mockSend.mockResolvedValueOnce(llmReply({ ...GOOD_REPLY, asked: 'other' }));
    const c = generateCaseSummary(passedReport({ id: 'report-other' }), testCase(), { persist });
    resolveSend(llmReply(GOOD_REPLY));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(ra.summary).toEqual(rb.summary);
    expect(rc.summary.parts.asked).toBe('other');
    expect(persist).toHaveBeenCalledTimes(2); // once per distinct generation
    // Once settled, the next call for the same report starts a new generation.
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    await generateCaseSummary(report, testCase(), {});
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('force=true bypasses a current cache once; a second force inside the cooldown is served from the cache (one paid call)', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const report = passedReport();
    const { summary } = await generateCaseSummary(report, testCase(), {});
    let resolveSend!: (v: any) => void;
    mockSend.mockImplementationOnce(() => new Promise((r) => { resolveSend = r; }));
    const forcedA = generateCaseSummary({ ...report, caseSummary: summary }, testCase(), { force: true });
    const forcedB = generateCaseSummary({ ...report, caseSummary: summary }, testCase(), { force: true });
    resolveSend(llmReply(GOOD_REPLY));
    const [a, b] = await Promise.all([forcedA, forcedB]);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 initial + 1 forced regeneration
    // Without a cache to fall back on, the in-cooldown force joins the running generation.
    _resetCaseSummaryThrottle();
    mockSend.mockImplementationOnce(() => new Promise((r) => { resolveSend = r; }));
    const c = generateCaseSummary(report, testCase(), { force: true });
    const d = generateCaseSummary(report, testCase(), { force: true });
    resolveSend(llmReply(GOOD_REPLY));
    const [rc, rd] = await Promise.all([c, d]);
    expect(rc.summary).toEqual(rd.summary);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('the model cannot flip the verdict: a "PASSED" reason on a failed report still reads FAILED; an unjudged run stays "Not judged"', async () => {
    mockSend.mockResolvedValueOnce(llmReply({ ...GOOD_REPLY, why: 'PASSED — everything was perfect' }));
    const failed = await generateCaseSummary(passedReport({ passFailStatus: 'failed' }), testCase(), {});
    expect(failed.summary.parts.verdict).toMatch(/^Judge verdict: FAILED \(score 90%\) — PASSED — everything was perfect\.$/);
    mockSend.mockResolvedValueOnce(llmReply({ ...GOOD_REPLY, why: 'the agent passed' }));
    const unjudged = await generateCaseSummary(agentErrorReport(), testCase(), {});
    expect(unjudged.summary.source).toBe('llm');
    expect(unjudged.summary.parts.verdict).toMatch(/^Not judged: the agent request failed — Agent request timed out/);
    expect(unjudged.summary.parts.verdict).not.toMatch(/passed/i);
  });

  it('a stuck downstream step (persist never settles) is released at the outer deadline instead of wedging the in-flight slot', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const pending = generateCaseSummary(passedReport(), testCase(), { timeoutMs: 50, persist: () => new Promise(() => {}) });
      await jest.advanceTimersByTimeAsync(50 + 10_000 + 1);
      const res = await pending;
      expect(res.summary.source).toBe('fallback');
      expect(res.summary.error).toMatch(/did not finish within/);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
    // The slot is free again: the next call starts a fresh generation.
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const next = await generateCaseSummary(passedReport(), testCase(), {});
    expect(next.summary.source).toBe('llm');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('returns the field-based fallback with the error when the model call fails, and does NOT persist it', async () => {
    mockSend.mockRejectedValueOnce(new Error('Could not load credentials from any providers'));
    const persist = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await generateCaseSummary(passedReport(), testCase(), { persist });
    warn.mockRestore();
    expect(res.cached).toBe(false);
    expect(res.summary.source).toBe('fallback');
    expect(res.summary.error).toBe('Could not load credentials from any providers');
    expect(res.summary.parts.verdict).toMatch(/^Judge verdict: PASSED/);
    expect(persist).not.toHaveBeenCalled();
  });

  it('a cached FALLBACK summary is never treated as current (the model is retried on the next view)', async () => {
    const inputs = buildCaseSummaryInputs(passedReport(), testCase());
    const fb = buildFallbackSummary(inputs, 'down');
    expect(isCaseSummaryCurrent(fb, inputs)).toBe(false);
  });

  it('times out a hung model call and falls back honestly', async () => {
    mockSend.mockImplementationOnce((_cmd: any, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
      })
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await generateCaseSummary(passedReport(), testCase(), { timeoutMs: 20 });
    warn.mockRestore();
    expect(res.summary.source).toBe('fallback');
    expect(res.summary.error).toMatch(/did not answer within/);
  });

  it('an unparseable model reply falls back (never a half-filled summary)', async () => {
    mockSend.mockResolvedValueOnce({ output: { message: { content: [{ text: 'Sure! The agent did well.' }] } } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await generateCaseSummary(passedReport(), testCase(), {});
    warn.mockRestore();
    expect(res.summary.source).toBe('fallback');
    expect(res.summary.error).toMatch(/no JSON object/);
  });

  it('a model id that cannot be resolved still yields the fallback, not an exception', async () => {
    const { resolveRegionAwareModelId } = jest.requireMock('@/lib/bedrockCompat');
    (resolveRegionAwareModelId as jest.Mock).mockImplementationOnce(() => { throw new Error('bad region config'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await generateCaseSummary(passedReport(), testCase(), {});
    warn.mockRestore();
    expect(res.summary.source).toBe('fallback');
    expect(res.summary.error).toBe('bad region config');
  });

  it('a persistence failure does not hide a good summary', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await generateCaseSummary(passedReport(), testCase(), { persist: async () => { throw new Error('disk full'); } });
    warn.mockRestore();
    expect(res.summary.source).toBe('llm');
    expect(res.summary.parts).toEqual(GOOD_PARTS);
  });

  it('CASE_SUMMARY_ENABLED=false: nothing is sent to the model; the field-based summary says why (and is not persisted)', async () => {
    process.env.CASE_SUMMARY_ENABLED = 'false';
    expect(isCaseSummaryModelEnabled()).toBe(false);
    const persist = jest.fn();
    const res = await generateCaseSummary(passedReport(), testCase(), { persist });
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.summary.source).toBe('fallback');
    expect(res.summary.error).toMatch(/disabled \(CASE_SUMMARY_ENABLED=false\)/);
    expect(persist).not.toHaveBeenCalled();
    // A current cached LLM summary is still served (nothing is sent either way).
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    delete process.env.CASE_SUMMARY_ENABLED;
    const { summary } = await generateCaseSummary(passedReport(), testCase(), {});
    process.env.CASE_SUMMARY_ENABLED = '0';
    const cached = await generateCaseSummary({ ...passedReport(), caseSummary: summary }, testCase(), {});
    expect(cached.cached).toBe(true);
    for (const v of ['true', '', 'yes', 'anything']) { process.env.CASE_SUMMARY_ENABLED = v; expect(isCaseSummaryModelEnabled()).toBe(true); }
    for (const v of ['false', '0', 'off', 'no', ' FALSE ']) { process.env.CASE_SUMMARY_ENABLED = v; expect(isCaseSummaryModelEnabled()).toBe(false); }
  });

  it('bounds concurrent model generations per process (CASE_SUMMARY_MAX_CONCURRENT, default 4): extra reports get the field-based summary', async () => {
    expect(getMaxConcurrentGenerations()).toBe(4);
    process.env.CASE_SUMMARY_MAX_CONCURRENT = '2';
    const resolvers: Array<(v: any) => void> = [];
    mockSend.mockImplementation(() => new Promise((r) => { resolvers.push(r); }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = generateCaseSummary(passedReport({ id: 'r-a' }), testCase(), {});
    const b = generateCaseSummary(passedReport({ id: 'r-b' }), testCase(), {});
    const c = await generateCaseSummary(passedReport({ id: 'r-c' }), testCase(), {});
    expect(c.summary.source).toBe('fallback');
    expect(c.summary.error).toMatch(/busy \(2 generations in flight, limit 2\)/);
    expect(mockSend).toHaveBeenCalledTimes(2);
    resolvers.forEach(r => r(llmReply(GOOD_REPLY)));
    await Promise.all([a, b]);
    // Slots freed → the next one is generated.
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const d = await generateCaseSummary(passedReport({ id: 'r-d' }), testCase(), {});
    expect(d.summary.source).toBe('llm');
    warn.mockRestore();
    mockSend.mockReset();
  });

  it('a second forced regeneration of the same report within the cooldown serves the cache instead of paying again', async () => {
    let t = 1_000_000;
    _resetCaseSummaryThrottle(() => t);
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const report = passedReport();
    const first = await generateCaseSummary(report, testCase(), { force: true });
    expect(first.cached).toBe(false);
    const withCache = { ...report, caseSummary: first.summary };
    t += 2_000;
    const second = await generateCaseSummary(withCache, testCase(), { force: true });
    expect(second.cached).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    t += 20_000;
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    const third = await generateCaseSummary(withCache, testCase(), { force: true });
    expect(third.cached).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('wires the Bedrock client with the refreshing credential provider and passes the abort signal (#569)', async () => {
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    await generateCaseSummary(passedReport(), testCase(), {});
    expect(createRefreshingCredentialProvider).toHaveBeenCalled();
    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    expect(mockClientCtor.mock.calls[0][0]).toMatchObject({ credentials: mockCredentialProvider });
    expect(mockSend.mock.calls[0][1]).toHaveProperty('abortSignal');
    // One long-lived client across calls (the provider's refresh state lives in it).
    mockSend.mockResolvedValueOnce(llmReply(GOOD_REPLY));
    await generateCaseSummary(passedReport({ id: 'report-2' }), testCase(), {});
    expect(mockClientCtor).toHaveBeenCalledTimes(1);
  });
});
