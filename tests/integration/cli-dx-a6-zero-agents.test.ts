/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for A6 - Zero agents warning wiring in
 * GET /api/storage/config/status.
 *
 * server/routes/storage/admin.ts's status handler used to call
 * `getConfigStatus()` with no arguments, so the zero-agents warning
 * computed inside `getConfigStatus(agents)` (server/services/configService.ts)
 * could never fire in practice — the route never passed the loaded config's
 * `agents` through. This test hits the real, running server (the same
 * fetch-against-getTestBackendUrl() pattern as
 * tests/integration/server/routes/config.integration.test.ts) to prove the
 * endpoint is wired end to end and returns the documented shape.
 *
 * The zero-agents branch itself (warnings[] populated when agents.length===0)
 * is exercised deterministically against the real exported function in the
 * unit test (tests/unit/cli-dx-guards.test.ts) — the integration test's
 * running server always has the repo's default/test agents configured, so it
 * pins the complementary, equally real regression: a normally-configured
 * server does NOT emit a false-positive zero-agents warning.
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=cli-dx-a6-zero-agents
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('A6 Integration - Config Status Zero Agents Warning', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        BASE_URL,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  it(
    'GET /api/storage/config/status returns 200 with the documented shape',
    async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/config/status`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('storage');
      expect(data).toHaveProperty('observability');
      expect(data).toHaveProperty('runtime');
      expect(data.runtime).toHaveProperty('storage');
    },
    TEST_TIMEOUT
  );

  it(
    'does not emit the zero-agents warning when the server has configured agents',
    async () => {
      if (!backendAvailable) return;

      // Sanity-check the precondition this regression relies on: the test
      // server's config declares at least one agent (it always does — see
      // tests/integration/server/routes/config.integration.test.ts's
      // DEFAULT_AGENT_COUNT). If that ever changes, this assertion's
      // "no warning" is the wrong test — fail loud instead of green-lying.
      const agentsResponse = await fetch(`${BASE_URL}/api/agents`);
      const agentsData = await agentsResponse.json();
      expect(agentsData.total).toBeGreaterThan(0);

      const response = await fetch(`${BASE_URL}/api/storage/config/status`);
      const data = await response.json();

      if (data.warnings !== undefined) {
        const hasZeroAgentsWarning = (data.warnings as string[]).some((w) =>
          w.includes('zero agents')
        );
        expect(hasZeroAgentsWarning).toBe(false);
      }
    },
    TEST_TIMEOUT
  );
});
