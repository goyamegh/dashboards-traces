/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Smoke test for the SDK end-to-end. Pure deterministic, no agent calls,
 * no judge calls. Should complete in <1s.
 */

const { test, expect } = require('@opensearch-project/agent-health');

test('deterministic-pass', () => {
  expect(2 + 2).to.equal(4);
  expect('hello').to.contain('lo');
  expect([1, 2, 3]).to.have.length(3);
});

test('deterministic-trajectory-empty', ({ result }) => {
  // No prompt, no agent invocation
  expect(result.durationMs).to.equal(0);
  expect(result.trajectory).to.have.length(0);
  expect(result.agentOutput).to.equal('');
});

test('deterministic-fail-on-purpose', ({ result }) => {
  // This test deliberately fails so we can see a failed matcher in the UI
  expect(result.durationMs).to.equal(999);   // will fail (durationMs is 0)
});
