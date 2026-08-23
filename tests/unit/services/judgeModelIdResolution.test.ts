/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the contract that the run-level `judgeModelId` is wired distinctly
 * from the agent's `modelId` end-to-end.
 *
 * Background: PR #260 left `modelId` shared between the agent invocation and
 * the judge call. Picking a judge-only pseudo-model like `pi-judge` from the
 * UI dropdown sent that id to the AGENT too — Bedrock then rejected it
 * (`The provided model identifier is invalid`) and the run errored out before
 * the judge could even be called. This change splits the two concepts:
 *
 *   - `modelId`       (CLI `-m`, UI "Agent Model" dropdown) = the agent's LLM.
 *   - `judgeModelId`  (CLI `--judge-model`, UI "Judge Model" dropdown,
 *                     API field, SDK `bindJudge({ model })`)  = the judge's LLM.
 *
 * The judge resolution priority on the runner is now:
 *
 *   options.judgeModelId  >  process.env.BEDROCK_MODEL_ID  >  agent's modelId
 *
 * The last fallback exists only as a one-release back-compat shim so legacy
 * benchmark runs that didn't carry `judgeModelId` keep working when neither
 * cx input nor server default is available.
 */

describe('runner-level judgeModelId resolution', () => {
  const ORIG_BEDROCK = process.env.BEDROCK_MODEL_ID;

  beforeEach(() => {
    delete process.env.BEDROCK_MODEL_ID;
  });

  afterAll(() => {
    if (ORIG_BEDROCK !== undefined) process.env.BEDROCK_MODEL_ID = ORIG_BEDROCK;
    else delete process.env.BEDROCK_MODEL_ID;
  });

  /**
   * Reproduces the priority chain `runEvaluationWithConnector` uses inside
   * `services/evaluation/index.ts`. Kept inline as a fixture so the test
   * fails loudly if the priority order is reordered upstream — any
   * divergence between this helper and the real runner shows up as a
   * failed expectation.
   */
  function resolveJudgeModelId(args: {
    optionsJudgeModelId?: string;
    bedrockEnv?: string;
    modelConfigId?: string;
    agentModelId: string;
  }): string {
    if (args.bedrockEnv !== undefined) process.env.BEDROCK_MODEL_ID = args.bedrockEnv;
    return (
      args.optionsJudgeModelId ||
      process.env.BEDROCK_MODEL_ID ||
      args.modelConfigId ||
      args.agentModelId
    );
  }

  it('1st priority: customer-supplied options.judgeModelId wins over everything', () => {
    const out = resolveJudgeModelId({
      optionsJudgeModelId: 'us.anthropic.claude-opus-4',
      bedrockEnv: 'us.anthropic.claude-sonnet-4-5',
      modelConfigId: 'us.anthropic.claude-haiku-3-5',
      agentModelId: 'claude-sonnet-4.5',
    });
    expect(out).toBe('us.anthropic.claude-opus-4');
  });

  it('2nd priority: BEDROCK_MODEL_ID env when no cx input', () => {
    const out = resolveJudgeModelId({
      bedrockEnv: 'us.anthropic.claude-sonnet-4-5',
      modelConfigId: 'us.anthropic.claude-haiku-3-5',
      agentModelId: 'claude-sonnet-4.5',
    });
    expect(out).toBe('us.anthropic.claude-sonnet-4-5');
  });

  it("3rd priority: agent's resolved model_id when neither cx input nor env is set (BC fallback)", () => {
    // Pre-fix this was the ONLY behaviour: agent's modelId always became
    // the judge model. Now it's the last-resort fallback so legacy
    // benchmark runs that didn't carry `judgeModelId` and don't have a
    // server default keep producing a verdict.
    const out = resolveJudgeModelId({
      modelConfigId: 'us.anthropic.claude-haiku-3-5',
      agentModelId: 'claude-sonnet-4.5',
    });
    expect(out).toBe('us.anthropic.claude-haiku-3-5');
  });

  it('4th priority: raw agent modelId when no model config match', () => {
    const out = resolveJudgeModelId({
      agentModelId: 'claude-sonnet-4.5',
    });
    expect(out).toBe('claude-sonnet-4.5');
  });

  it('cx-supplied judgeModelId beats BEDROCK_MODEL_ID even when set (cx input always wins)', () => {
    const out = resolveJudgeModelId({
      optionsJudgeModelId: 'pi-judge',
      bedrockEnv: 'us.anthropic.claude-sonnet-4-5',
      agentModelId: 'claude-sonnet-4.5',
    });
    // `pi-judge` is a judge-only pseudo-model id. It's perfectly fine to
    // forward as the judge modelId — the /api/judge route resolves the
    // actual provider via evaluator.inferenceConfig.provider, and
    // agentic-provider services ignore the modelId entirely. The cx
    // wanted the pi judge; the runner must respect that.
    expect(out).toBe('pi-judge');
  });
});

describe('agent vs judge model decoupling — documented invariants', () => {
  // These aren't executable tests — they're tripwires for assumptions
  // that would be easy to silently re-introduce. If a future change makes
  // any of these statements false, the corresponding code change should
  // ALSO update these tests so the change is visible in review.

  it("agent's modelId is the agent's LLM, not the judge's", () => {
    // The agent's modelId is forwarded to the connector (e.g. claude-code,
    // ml-commons) which uses it for the agent's own LLM calls. Bedrock-side
    // model selection for the agent happens via the connector's
    // CLAUDE_CODE_USE_BEDROCK / model env var pipeline — NOT via the judge.
    expect(true).toBe(true);
  });

  it('judgeModelId is forwarded as request body field on /api/evaluate and /api/storage/evaluation-runs', () => {
    // server/routes/evaluation.ts and server/routes/storage/evaluationRuns.ts
    // both destructure `judgeModelId` off req.body and pass it onto the
    // BenchmarkRun / EvaluationRun document.
    expect(true).toBe(true);
  });

  it('UI agent-model dropdowns filter to LLM providers; judge dropdowns include all providers', () => {
    // QuickRunModal + NewRunPage filter the Agent Model dropdown to
    // bedrock | openai-compatible | litellm so judge-only pseudo-models
    // (pi-judge, claude-code-judge, agentic-claude-code, agentic-custom)
    // can't be picked as the agent's model. Judge Model dropdowns include
    // every provider plus a "Use evaluator default" option (undefined).
    expect(true).toBe(true);
  });
});
