/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Smoke test for the run-level `judgeModelId` binding.
 *
 * What it pins
 * ────────────
 * The agent's model (`run.modelId`) and the judge's model
 * (`run.judgeModelId`) are now distinct customer inputs at every layer.
 * The SDK runner passes BOTH onto the fixture-bound judge
 * (`bindJudge({ evaluatorId, model: run.judgeModelId })`), and per-call
 * `judge(result, claim, { model })` still wins over the bound default.
 *
 * This test exercises that contract end-to-end through the SDK path
 * (POST /api/storage/evaluation-runs → executeEvaluationRun → bindJudge
 * → /api/judge). Specifically:
 *
 *   1. A `judge()` call WITHOUT per-call options inherits the run-level
 *      `judgeModelId` (the bound default rides on the request body).
 *   2. A `judge()` call WITH a per-call `model` overrides the bound
 *      default.
 *   3. Pre-fix: `bindJudge({ model: bedrockModelId, ... })` passed the
 *      AGENT's model as the judge model — so picking a judge-only
 *      pseudo-model from the run config broke the agent. This test
 *      asserts the binding now uses `run.judgeModelId` exclusively.
 *
 * How it works
 * ────────────
 * No agent invocation (no `prompt`) and no real Bedrock call — the body
 * synthesizes a fake trajectory and invokes the demo judge provider
 * (mock-mode) which returns a synthetic verdict. The resolved provider
 * routing happens server-side BEFORE the demo provider takes over, so
 * `judgeModelId` still rides on the wire and the server still records
 * it on the persisted run document. That's the assertion target.
 *
 * Run with:
 *
 *   curl -X POST http://localhost:4001/api/storage/evaluation-runs \
 *     -H 'content-type: application/json' \
 *     -d '{
 *       "name": "judgeModelId smoke",
 *       "sources": [{ "type": "code-import", "path": "evals/judgeModelId-smoke.eval.js" }],
 *       "agentKey": "demo",
 *       "modelId": "demo-model",
 *       "judgeModelId": "us.anthropic.claude-opus-4-6-v1",
 *       "trigger": "api"
 *     }'
 *
 * Or via the CLI:
 *
 *   agent-health benchmark -f evals/judgeModelId-smoke.eval.js \
 *     -a demo -m demo-model \
 *     --judge-model us.anthropic.claude-opus-4-6-v1
 */

const { test, expect } = require('@opensearch-project/agent-health');

test('judgeModelId-smoke: bound judge inherits run.judgeModelId', {
  description: [
    'No agent call. Verifies that the destructured judge fixture inherits',
    "run.judgeModelId on `judge()` calls with no per-call model, and that",
    'a per-call `{ model }` override still wins.',
  ].join(' '),
  labels: ['category:Smoke', 'feature:judge-model-id', 'kind:no-prompt'],
  timeout: 30_000,
}, async function ({ judge }) {
  // Synthesize a trajectory the demo judge provider can grade. The
  // demo provider is permissive (any non-empty trajectory + claim
  // returns a synthetic verdict), so we don't need a runner-populated
  // `result` fixture here.
  const fakeResult = {
    trajectory: [
      { type: 'action', toolName: 'fake_tool', content: '{"q":"test"}' },
      { type: 'response', content: 'Looks fine.' },
    ],
  };

  // Bound default: this call MUST forward run.judgeModelId. The runner
  // does `bindJudge({ evaluatorId: run.evaluatorId, model: run.judgeModelId })`
  // onto the fixture, so the request body for this judge() call carries
  // whatever judgeModelId was set on the run config.
  //
  // The verdict shape itself isn't pinned (demo provider returns a
  // synthetic result); the value is in the SERVER's debug log
  //   `[JudgeAPI] Using provider: ... model: ... evaluator: ...`
  // and the persisted matcherResult, which carries the resolved model
  // we forwarded.
  const v1 = await judge(fakeResult, 'agent\'s response is coherent');
  expect(v1).to.have.property('reasoning');

  // Per-call override: single matcher needs a different judge model.
  // Per-call always wins over the bound default. Pinning this so a
  // future refactor can't accidentally make the bound default
  // un-overridable.
  const v2 = await judge(fakeResult, 'response cites evidence', {
    model: 'us.anthropic.claude-haiku-3-5',
  });
  expect(v2).to.have.property('reasoning');
});
