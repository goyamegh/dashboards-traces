/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: Issue #184 - useTraces benchmark blocking behavior
 *
 * Verifies the end-to-end behavioral contract:
 * When an agent has useTraces: true, the /api/evaluate endpoint MUST block
 * until trace polling completes (either traces found + judge evaluated, or
 * timeout) before sending the final SSE 'completed' event.
 *
 * Requirements:
 * - Backend server running: npm run dev:server
 * - Observio agent running on port 3001: cd observio-sample-agent && npm run start:ag-ui
 *
 * Run:
 *   npm test -- tests/integration/services/evaluation/traceBlocking.integration.test.ts
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const OBSERVIO_PORT = 3001;

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Check if observio agent is available
const checkObservio = async (): Promise<boolean> => {
  try {
    const response = await fetch(`http://localhost:${OBSERVIO_PORT}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Create a test case for evaluation
const createTestCase = async (): Promise<string | null> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Integration Test - Trace Blocking #184',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'What files are in the /tmp directory?',
        expectedOutcomes: [
          'Use a filesystem tool to list directory contents',
          'Return information about files found',
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      return data.id;
    }
    return null;
  } catch {
    return null;
  }
};

// Delete a test case
const deleteTestCase = async (id: string): Promise<void> => {
  try {
    await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    // Ignore cleanup errors
  }
};

// Delete a report doc (server-adapter `runs` storage). /api/evaluate
// pre-creates a placeholder report immediately (before the agent even
// starts) and updates it in place as the run progresses — nothing else in
// this test file deletes it, so it must be tracked and removed explicitly.
const deleteReport = async (id: string): Promise<void> => {
  try {
    await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    // Ignore cleanup errors
  }
};

// Parse SSE events from a streaming response
function parseSSEEvents(text: string): Array<{ type: string; [key: string]: any }> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('Issue #184 - useTraces benchmark blocking (integration)', () => {
  let backendAvailable = false;
  let observioAvailable = false;
  let testCaseId: string | null = null;
  // Report doc(s) /api/evaluate creates for this test case. Populated from
  // the SSE 'started'/'completed' events (see the two `it()` blocks below)
  // and deleted in afterAll — nothing else in the app deletes these.
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    observioAvailable = await checkObservio();

    if (!backendAvailable) {
      console.warn('Backend not available at', BASE_URL, '- skipping integration tests');
      console.warn('Start with: npm run dev:server');
    }
    if (!observioAvailable) {
      console.warn('Observio agent not available on port', OBSERVIO_PORT, '- skipping');
      console.warn('Start with: cd observio-sample-agent && AG_UI_PORT=3001 npx ts-node src/main_ag_ui.ts');
    }

    if (backendAvailable) {
      testCaseId = await createTestCase();
    }
  });

  afterAll(async () => {
    for (const id of createdReportIds) {
      await deleteReport(id);
    }
    if (testCaseId) {
      await deleteTestCase(testCaseId);
    }
  });

  it('should return immediately with metricsStatus pending via /api/evaluate (UI mode)', async () => {
    if (!backendAvailable || !observioAvailable || !testCaseId) {
      // Skip gracefully — test reports as passed but with warning
      // (matches repo convention for integration tests requiring external services)
      console.warn('Skipping: prerequisites not met (backend/observio/testCaseId)');
      return;
    }

    expect.hasAssertions(); // Ensure at least one assertion runs when not skipped

    // The /api/evaluate endpoint uses awaitTraces: false (UI mode)
    // It should return quickly with metricsStatus: 'pending'
    const startTime = Date.now();

    const response = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId,
        agentKey: 'observio',
        modelId: 'claude-sonnet-4.6',
      }),
    });

    const text = await response.text();
    const elapsed = Date.now() - startTime;
    const events = parseSSEEvents(text);

    const startedEvent = events.find((e) => e.type === 'started');
    const stepEvents = events.filter((e) => e.type === 'step');
    const completedEvent = events.find((e) => e.type === 'completed');

    // Track the report doc(s) this call created, regardless of which
    // assertions below pass — server/routes/evaluation.ts pre-creates a
    // placeholder report (surfaced as `started.reportId`) before the agent
    // even runs, then updates that SAME doc id in place, so `started` and
    // `completed` always reference one report.
    if (startedEvent?.reportId) createdReportIds.push(startedEvent.reportId);
    if (completedEvent?.report?.id) createdReportIds.push(completedEvent.report.id);
    if (completedEvent?.reportId) createdReportIds.push(completedEvent.reportId);

    // Agent ran successfully
    expect(startedEvent).toBeDefined();
    expect(stepEvents.length).toBeGreaterThan(0);

    // Completed event IS sent (UI mode returns immediately)
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.report.metricsStatus).toBe('pending');

    // Should complete in <30s (just agent execution, no trace waiting)
    expect(elapsed).toBeLessThan(30000);

    console.log(`✓ UI path returned in ${elapsed}ms with metricsStatus=pending`);
    console.log(`  Agent steps: ${stepEvents.length}`);
  }, 35000);

  it('should eventually report error metricsStatus when traces are not available', async () => {
    if (!backendAvailable || !observioAvailable || !testCaseId) {
      console.warn('Skipping: prerequisites not met (backend/observio/testCaseId)');
      return;
    }

    // This test waits for the full trace poller timeout (up to 5 min with defaults).
    // We only run it if FULL_TRACE_TEST=true is set.
    if (!process.env.FULL_TRACE_TEST) {
      console.warn('Skipping full trace timeout test (set FULL_TRACE_TEST=true to enable)');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId,
        agentKey: 'observio',
        modelId: 'claude-sonnet-4.6',
      }),
    });

    const text = await response.text();
    const events = parseSSEEvents(text);
    const startedEvent = events.find((e) => e.type === 'started');
    const completedEvent = events.find((e) => e.type === 'completed');

    // Same tracking as the first test — this call also creates a real
    // report doc that nothing else in the app deletes.
    if (startedEvent?.reportId) createdReportIds.push(startedEvent.reportId);
    if (completedEvent?.report?.id) createdReportIds.push(completedEvent.report.id);
    if (completedEvent?.reportId) createdReportIds.push(completedEvent.reportId);

    // After full timeout, the report should show 'error' metricsStatus
    // (not 'pending' which was the bug)
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.report.metricsStatus).toBe('error');
    expect(completedEvent!.report.metrics.accuracy).toBe(0);
  }, 360000); // 6 minute timeout
});
