/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimized regression fixture for the ".eval.ts can't execute" bug
 * ("Module ... has no test cases" from the CLI + server loader).
 *
 * Trimmed down (structure, imports, and comment style only — no
 * proprietary content) from a real user repro that hit this exact
 * failure: a `.eval.ts` file importing the SDK by package name
 * (`import { test } from '@opensearch-project/agent-health'`) registered
 * zero test cases when the host process (CLI/server) itself resolved
 * `lib/testCases/define.ts` to a *different physical module* than the one
 * Node's package resolution handed the `.eval.ts` file — two distinct
 * module instances, two distinct registries.
 *
 * Deliberately deterministic (no `prompt`, so the runner skips agent
 * invocation) — this fixture's job is to prove `.ts` registration +
 * execution works end-to-end through the CLI → server → storage pipeline,
 * not to exercise a real agent.
 */

import { test, describe, expect } from '@opensearch-project/agent-health';

// Top-level test (outside any describe()) — lands in the file-default
// benchmark, exactly like the real repro's three top-level test() calls.
test('evalts-top-level-case', {
  description: 'Deterministic top-level .eval.ts test case (no prompt)',
  labels: ['category:CodeQA', 'difficulty:Easy', 'suite:evalts-regression'],
}, ({ expect, testInfo }) => {
  expect(testInfo.name).to.equal('evalts-top-level-case');
  expect(1 + 1).to.equal(2);
});

// describe()-scoped test — proves benchmarkPath derivation also works for
// a native-imported .ts module, not just the eval()'d .js path.
describe('EvalTS Suite', () => {
  test('evalts-describe-case', {
    description: 'Deterministic describe()-scoped .eval.ts test case',
    labels: ['category:CodeQA', 'difficulty:Easy'],
  }, ({ expect }) => {
    expect('agent-health').to.include('health');
  });
});
