/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample code-based test case fixture for Observio agent.
 *
 * Format: CJS (module.exports) for Jest compatibility.
 */

const { test } = require('../../lib/testCases/define');

test('Observio Basic Response', {
  prompt: 'What is the root cause of high CPU usage on the web server?',
  description: 'Verify that Observio agent produces a non-empty trajectory and response',
  context: [
    {
      description: 'Alert context',
      value: 'High CPU alert triggered on web-server-01 at 2024-01-15T10:30:00Z',
    },
  ],
  labels: ['category:RCA', 'difficulty:Easy', 'agent:observio'],
}, function (result) {
  if (!result.trajectory || result.trajectory.length === 0) {
    throw new Error(
      'Expected trajectory to have at least one step, got empty trajectory'
    );
  }

  if (!result.agentOutput || result.agentOutput.trim().length === 0) {
    throw new Error('Expected non-empty agent output');
  }

  if (typeof result.durationMs !== 'number' || result.durationMs <= 0) {
    throw new Error(
      'Expected positive durationMs, got: ' + result.durationMs
    );
  }
});

test('Observio Trajectory Structure', {
  prompt: 'Analyze the error logs and identify the failing service.',
  description: 'Verify that Observio trajectory contains expected step types',
  context: [
    {
      description: 'Error log snippet',
      value: 'ERROR 2024-01-15 10:31:22 [payment-service] Connection refused to database-primary:5432',
    },
  ],
  labels: ['category:RCA', 'difficulty:Medium', 'agent:observio'],
}, function (result) {
  if (!result.trajectory || result.trajectory.length === 0) {
    throw new Error('Expected non-empty trajectory');
  }

  var hasResponse = result.trajectory.some(function (step) {
    return step.type === 'response';
  });

  if (!hasResponse) {
    var stepTypes = result.trajectory.map(function (s) { return s.type; });
    throw new Error(
      'Expected at least one response step in trajectory. Got types: ' +
      stepTypes.join(', ')
    );
  }
});
