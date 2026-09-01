/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the ongoing-runs-visibility fix:
 *   POST /api/storage/evaluation-runs (with a benchmarkId) now links a
 *   `running` projection into `benchmark.runs` immediately, keeps it in
 *   sync with per-test-case progress, and syncs the same entry to a
 *   terminal status (completed/failed) exactly once — never duplicated,
 *   never left stuck on 'running'.
 *
 * These tests require the backend server to be running:
 *   npm run build:server && AH_PORT=4321 node server/dist/index.js
 *
 * Run:
 *   AH_PORT=4321 npm run test:integration -- --testPathPattern=evaluationRunsBenchmarkVisibility
 */

import { getTestBackendUrl, checkJudgeAvailable } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

async function isBackendUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function createTestCase(name: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'Reply with exactly: ok',
      expectedOutcomes: ['ok'],
      labels: ['@integration-test'],
    }),
  });
  if (!r.ok) throw new Error(`Failed to create test case: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

async function createBenchmark(name: string, testCaseIds: string[]): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'ongoing-runs-visibility integration test',
      testCaseIds,
      runs: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    }),
  });
  if (!r.ok) throw new Error(`Failed to create benchmark: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

async function getBenchmark(id: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed GET benchmark ${id}: ${r.status}`);
  return r.json();
}

async function getEvaluationRun(id: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed GET evaluation run ${id}: ${r.status}`);
  return r.json();
}

/** Parse SSE `event:`/`data:` blocks out of a raw text buffer. */
function parseSSEEvents(text: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n').filter(b => b.trim())) {
    let eventType = '';
    let eventData = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) eventData = line.slice(6);
    }
    if (eventData) {
      try { events.push({ event: eventType, data: JSON.parse(eventData) }); } catch { /* skip */ }
    }
  }
  return events;
}

/**
 * Start an evaluation run against `benchmarkId` and read the SSE stream
 * until (a) the `started` event has been seen and (b) the stream itself
 * ends (run reached a terminal state). Returns the runId plus every parsed
 * event, so callers can assert on both the mid-flight window (right after
 * `started`, before this function returns) via a separate GET, and the
 * final events.
 */
async function runEvaluation(body: Record<string, any>): Promise<{ runId: string; startedAt: number; done: Promise<{ text: string; events: Array<{ event: string; data: any }> }> }> {
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let runId = '';
  // Read until we've seen the `started` event (gives us the runId + the
  // earliest possible window to check "is it visible as running yet?").
  for (let i = 0; i < 20; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('event: started')) {
      const started = parseSSEEvents(text).find(e => e.event === 'started');
      if (started) { runId = started.data.runId; break; }
    }
  }
  if (!runId) throw new Error(`Never saw a 'started' SSE event. Raw: ${text}`);

  // Keep draining in the background until the stream ends (terminal state),
  // returned as a promise callers can await once they're done inspecting
  // the mid-flight window.
  const done = (async () => {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      text += decoder.decode(value, { stream: true });
    }
    return { text, events: parseSSEEvents(text) };
  })();

  return { runId, startedAt: Date.now(), done };
}

const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];
const createdEvalRunIds: string[] = [];
const createdReportIds: string[] = [];

describe('Evaluation Runs — ongoing/failed run visibility on benchmark.runs (integration)', () => {
  jest.setTimeout(60_000);

  let backendUp = false;
  let judgeAvailable = false;

  beforeAll(async () => {
    backendUp = await isBackendUp();
    if (!backendUp) {
      console.warn('Backend not available — skipping. Start with: AH_PORT=4321 node server/dist/index.js');
      return;
    }
    judgeAvailable = await checkJudgeAvailable(BASE_URL);
    if (!judgeAvailable) {
      console.warn('No real Bedrock judge available in this environment — completed-run assertions will be skipped.');
    }
  });

  afterAll(async () => {
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdEvalRunIds) {
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdBenchmarkIds) {
      await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('shows the run as `running` on GET /benchmarks/:id WHILE it is still executing, then syncs a SINGLE completed entry (not duplicated)', async () => {
    if (!backendUp || !judgeAvailable) return;

    const tc = await createTestCase('ongoing-visibility-completed-' + Date.now());
    createdTestCaseIds.push(tc);
    const bmId = await createBenchmark('ongoing-visibility-completed-bm-' + Date.now(), [tc]);
    createdBenchmarkIds.push(bmId);

    const { runId, done } = await runEvaluation({
      name: 'Ongoing Visibility Completed',
      sources: [{ type: 'test-case-ids', ids: [tc] }],
      agentKey: 'demo',
      modelId: 'claude-sonnet-4.6',
      benchmarkId: bmId,
      trigger: 'api',
    });
    createdEvalRunIds.push(runId);

    // Mid-flight: the run is executing a real (Bedrock) judge call right
    // now, so this GET reliably lands before completion.
    const midFlight = await getBenchmark(bmId);
    const midEntry = (midFlight.runs || []).find((r: any) => r.id === runId);
    expect(midEntry).toBeDefined();
    expect(midEntry.status).toBe('running');
    expect(midEntry.results[tc]).toEqual({ reportId: '', status: 'pending' });

    // Drain to completion.
    const { events } = await done;
    const completedEvent = events.find(e => e.event === 'completed');
    expect(completedEvent).toBeDefined();
    if (completedEvent.data.results?.[tc]?.reportId) {
      createdReportIds.push(completedEvent.data.results[tc].reportId);
    }

    const finalRun = await getEvaluationRun(runId);
    expect(finalRun.status).toBe('completed');

    const finalBenchmark = await getBenchmark(bmId);
    const matches = (finalBenchmark.runs || []).filter((r: any) => r.id === runId);
    expect(matches).toHaveLength(1); // never duplicated
    expect(matches[0].status).toBe('completed');
    expect(matches[0].results[tc].status).toBe('completed');
  });

  it('a run that fails outright still ends up linked as `failed` on benchmark.runs (previously invisible entirely)', async () => {
    if (!backendUp) return;

    const tc = await createTestCase('ongoing-visibility-failed-' + Date.now());
    createdTestCaseIds.push(tc);
    const bmId = await createBenchmark('ongoing-visibility-failed-bm-' + Date.now(), [tc]);
    createdBenchmarkIds.push(bmId);

    const { runId, done } = await runEvaluation({
      name: 'Ongoing Visibility Failed',
      sources: [{ type: 'test-case-ids', ids: [tc] }],
      // No agent registered under this key — executeEvaluationRun rejects
      // with "Agent not found", exercising the create route's failure path
      // without needing Bedrock credentials.
      agentKey: 'nonexistent-agent-for-integration-test',
      benchmarkId: bmId,
      trigger: 'api',
    });
    createdEvalRunIds.push(runId);

    const { events } = await done;
    expect(events.some(e => e.event === 'error')).toBe(true);

    const finalRun = await getEvaluationRun(runId);
    expect(finalRun.status).toBe('failed');

    const finalBenchmark = await getBenchmark(bmId);
    const matches = (finalBenchmark.runs || []).filter((r: any) => r.id === runId);
    expect(matches).toHaveLength(1); // linked exactly once, not left invisible
    expect(matches[0].status).toBe('failed');
  });

  it('cancelling a run syncs benchmark.runs to cancelled', async () => {
    if (!backendUp || !judgeAvailable) return;

    const tc1 = await createTestCase('ongoing-visibility-cancel-1-' + Date.now());
    const tc2 = await createTestCase('ongoing-visibility-cancel-2-' + Date.now());
    createdTestCaseIds.push(tc1, tc2);
    const bmId = await createBenchmark('ongoing-visibility-cancel-bm-' + Date.now(), [tc1, tc2]);
    createdBenchmarkIds.push(bmId);

    const { runId, done } = await runEvaluation({
      name: 'Ongoing Visibility Cancel',
      sources: [{ type: 'test-case-ids', ids: [tc1, tc2] }],
      agentKey: 'demo',
      modelId: 'claude-sonnet-4.6',
      benchmarkId: bmId,
      trigger: 'api',
      concurrency: 1,
    });
    createdEvalRunIds.push(runId);

    const cancelRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelRes.ok).toBe(true);

    // The cancel route's own sync should be visible almost immediately.
    let cancelledEntry: any;
    for (let i = 0; i < 20; i++) {
      const bm = await getBenchmark(bmId);
      cancelledEntry = (bm.runs || []).find((r: any) => r.id === runId);
      if (cancelledEntry?.status === 'cancelled') break;
      await new Promise(r => setTimeout(r, 250));
    }
    expect(cancelledEntry?.status).toBe('cancelled');

    const { events } = await done;
    for (const e of events) {
      const reportId = e.data?.results?.[tc1]?.reportId || e.data?.result?.reportId;
      if (reportId) createdReportIds.push(reportId);
    }
  });
});
