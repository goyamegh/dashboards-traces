/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Demo eval — three test cases that show off the SDK end-to-end against
 * the live Observio agent.
 *
 *   1. observio-says-hello       Pure deterministic, no LLM (free, fast)
 *   2. observio-uses-a-tool      Trajectory inspection — must invoke at least one tool
 *   3. observio-rca-is-coherent  Hybrid — deterministic preflight + targeted LLM judge
 *
 * Run with:
 *   curl -sN -X POST http://localhost:4002/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"SDK Demo",
 *       "sources":[{"type":"code-import","filenames":["evals/demo.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"observio",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, judge } = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Pure deterministic — no LLM, $0, fully reproducible
// ─────────────────────────────────────────────────────────────────────────────

test('observio-says-hello', {
  prompt: 'Say hello to me in one short sentence.',
  category: 'Smoke',
  difficulty: 'Easy',
  description: 'Smoke test: agent produces a non-trivial response',
  labels: ['demo', 'agent:observio'],
}, function (result) {
  // Must produce a trajectory
  if (!result.trajectory || result.trajectory.length === 0) {
    throw new Error('Empty trajectory');
  }

  // Must have an actual response (AG-UI emits 'assistant' as the terminal step type)
  if (!result.agentOutput || result.agentOutput.trim().length === 0) {
    throw new Error('Agent produced no final output');
  }

  // Reasonable timing
  if (result.durationMs > 60_000) {
    throw new Error('Run took too long: ' + result.durationMs + 'ms');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Trajectory inspection — proves the agent actually investigates
// ─────────────────────────────────────────────────────────────────────────────

test('observio-uses-a-tool', {
  prompt: 'Find the source of the most recent error log entry.',
  category: 'Tool Use',
  difficulty: 'Medium',
  description: 'Agent must call at least one tool, not just answer from memory',
  labels: ['demo', 'agent:observio'],
}, function (result) {
  const actions = result.trajectory.filter(function (s) { return s.type === 'action'; });
  if (actions.length === 0) {
    var stepTypes = result.trajectory.map(function (s) { return s.type; });
    throw new Error(
      'Agent answered without invoking any tools. ' +
      'Step types seen: ' + stepTypes.join(', ')
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Hybrid — deterministic preflight + targeted LLM judge
// ─────────────────────────────────────────────────────────────────────────────

test('observio-rca-is-coherent', {
  prompt: 'Diagnose why the payment service is failing and explain the root cause.',
  category: 'RCA',
  difficulty: 'Hard',
  description: 'Hybrid: cheap structural checks first, then LLM judge for semantic correctness',
  context: [
    {
      description: 'Error log',
      value: 'ERROR 2024-01-15 10:31:22 [payment-service] Connection refused to database-primary:5432',
    },
  ],
  labels: ['demo', 'agent:observio', 'hybrid'],
}, async function (result) {
  // Cheap deterministic preflight — fail fast, never spend $ on the judge
  if (!result.trajectory || result.trajectory.length === 0) {
    throw new Error('Empty trajectory');
  }
  if (result.durationMs > 120_000) {
    throw new Error('Run exceeded budget: ' + result.durationMs + 'ms');
  }
  if (!/payment[- ]service/i.test(result.agentOutput)) {
    throw new Error('Response never mentioned payment-service');
  }

  // Now invoke the LLM judge for the semantic claim. This makes the result
  // a 'hybrid' evaluation in the new metadata model.
  await judge(result.trajectory, [
    'Correctly identifies that the payment-service cannot connect to its database',
    'Provides a plausible root-cause hypothesis (e.g. database down, network issue)',
  ]);
});
