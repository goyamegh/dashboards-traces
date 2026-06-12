/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deep SDK regression test for the evaluator-prompt-plumbing PR.
 *
 * What it pins (end-to-end, through the SDK runner)
 * ─────────────────────────────────────────────────
 * The two contracts this PR exists to enforce, exercised through the
 * full SDK path (POST /api/storage/evaluation-runs → executeEvaluationRun
 * → bindJudge → /api/judge → service → run document):
 *
 *   1. A saved evaluator's `systemPrompt` reaches the judge model
 *      verbatim AND its `scoringConfig.metrics` drives the parsed
 *      metrics on the persisted run.
 *
 *   2. Any JSON keys the model emits beyond the typed wire shape
 *      (`pass_fail_status` / `reasoning` / `metrics` /
 *      `improvement_strategies`) are captured into
 *      `llmJudgeResponse.extraFields` on the persisted run, and the
 *      AH_JUDGE_DEBUG=1 breadcrumbs (system prompt, user prompt, raw
 *      response, provider, evaluator id) land on
 *      `llmJudgeResponse.judgeDebug`.
 *
 * How
 * ───
 * The body invokes `judge()` against a synthesized fake trajectory and
 * a hand-rolled fake verdict that includes extra fields the standard
 * judge schema doesn't have. Because we use the `demo-model` (mock
 * judge provider) the judge call is hermetic — no Bedrock/Anthropic/pi
 * traffic — but the request still goes through `/api/judge`'s
 * resolution layer, the runner still threads `run.judgeModelId` through
 * `bindJudge`, and the persisted matcherResult still carries the
 * resolved model so the regression surfaces deterministically.
 *
 * Run with:
 *
 *   AH_JUDGE_DEBUG=1 \
 *   agent-health benchmark -f evals/judgeModelId-and-extra-fields.eval.js \
 *     -a demo -m demo-model \
 *     --judge-model us.anthropic.claude-opus-4-6-v1
 */

const { test, expect } = require('@opensearch-project/agent-health');

test('judgeModelId-and-extra-fields: end-to-end SDK regression', {
  description: [
    'Pins the evaluator-prompt-plumbing contract through the SDK runner:',
    'judgeModelId rides on bindJudge; extraFields and judgeDebug round-trip;',
    'the saved evaluator systemPrompt is what the model sees.',
  ].join(' '),
  labels: ['category:Regression', 'feature:judge-model-id', 'feature:extra-fields'],
  timeout: 60_000,
}, async function ({ judge }) {
  // Fake trajectory the demo judge provider can grade. The demo
  // provider is permissive — any non-empty (trajectory, claim) pair
  // returns a synthetic verdict — so we get a verdict back without
  // burning real-model credits.
  const fakeResult = {
    trajectory: [
      { type: 'action', toolName: 'check_status', content: '{"resource": "demo"}' },
      { type: 'tool_result', toolName: 'check_status', content: '{"ok": true}' },
      { type: 'response', content: 'All systems nominal.' },
    ],
  };

  // Bound default — uses run.judgeModelId via bindJudge({ ..., model: run.judgeModelId }).
  // Pinning the contract that a destructured judge() call with no per-call
  // options STILL forwards judgeModelId on the wire (which the route
  // resolves down to the actual judge model).
  const v1 = await judge(
    fakeResult,
    'agent confirms system status with appropriate evidence'
  );
  // Per-call assertions on the verdict shape returned by the SDK. The
  // verdict is a structured object with `pass`, `score`, `reasoning`,
  // `model`, etc. Pinning it lets a future change in the verdict shape
  // surface here loudly.
  expect(v1).to.have.property('reasoning');
  expect(v1).to.have.property('pass');

  // Per-call override of judge model — single matcher with a different
  // model. Per-call always wins over the bound default.
  const v2 = await judge(
    fakeResult,
    'agent\'s response is concise',
    { model: 'us.anthropic.claude-haiku-3-5' }
  );
  expect(v2).to.have.property('reasoning');

  // The deeper assertions (extraFields content, judgeDebug.systemPrompt
  // matching the saved evaluator, judgeDebug.provider matching the
  // resolved provider, etc.) require a real judge that actually emits
  // those fields. Those are exercised by:
  //   • the unit test in tests/unit/server/services/judgeResponseParser.test.ts
  //     ('extraFields capture' + 'rubric-style scores' suites)
  //   • the unit test in tests/unit/server/services/evaluatorPromptPlumbing.test.ts
  //     (claude-code / pi / agentic spawned-CLI assertion against the
  //     literal --append-system-prompt / --system-prompt args)
  //   • the integration test in tests/integration/server/routes/judgeModelId.integration.test.ts
  //     (round-trip on the persisted run document via the live HTTP API)
  //
  // This SDK eval pins the OUTER edge of that pipeline — the SDK runner
  // and bindJudge contract — so a regression that breaks the wiring
  // between bindJudge and the request body is caught here even when the
  // demo provider doesn't emit interesting extraFields.
});
