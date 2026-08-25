/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: POST /api/storage/evaluation-runs/:id/resume
 *
 * Checkpoint-resume: resuming an interrupted evaluation
 * run must
 *   1. re-execute ONLY the test cases without a persisted report,
 *   2. preserve completed results (their reportIds untouched),
 *   3. finish the run with status=completed and full-size stats,
 *   4. reject a second resume with 400 (nothing left to resume),
 *   5. 404 for unknown run ids.
 *
 * Uses the built-in `demo` agent (mock://demo) + `demo-model` judge so no
 * AWS credentials are needed. Runs against a live backend (npm run
 * dev:server) — self-skips when unreachable.
 */

import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 120_000;
const BASE_URL = getTestBackendUrl();

function httpJson<T = any>(
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: T; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T), raw: text });
          } catch {
            resolve({ status: res.statusCode || 0, body: text as any, raw: text });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Parse a named-event SSE stream ("event: X\ndata: {...}") into [{event, data}]. */
function parseSSE(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split('\n\n')
    .map((block) => {
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!event || !data) return null;
      try { return { event, data: JSON.parse(data) }; } catch { return null; }
    })
    .filter((e): e is { event: string; data: any } => !!e);
}

describe('POST /api/storage/evaluation-runs/:id/resume — checkpoint resume', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdReportIds: string[] = [];
  let runId: string | undefined;

  beforeAll(async () => {
    try {
      const health = await httpJson('GET', `${BASE_URL}/api/agents`);
      backendAvailable = health.status === 200;
    } catch {
      backendAvailable = false;
    }
    if (!backendAvailable) {
      console.warn('[evaluationRunResume] Backend not reachable — skipping');
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of createdReportIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    if (runId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
  }, TEST_TIMEOUT);

  it(
    'resumes only unfinished test cases, preserves completed reports, then 400s when nothing is left',
    async () => {
      if (!backendAvailable) return;

      // 1. Three minimal test cases.
      for (let i = 1; i <= 3; i++) {
        const tc = await httpJson<any>('POST', `${BASE_URL}/api/storage/test-cases`, {
          name: `resume-int-tc${i}`,
          category: 'Diagnostics',
          difficulty: 'Easy',
          initialPrompt: `Say hello (${i})`,
          expectedOutcomes: ['Agent responds'],
          labels: [],
        });
        expect(tc.status).toBeLessThan(300);
        createdTestCaseIds.push(tc.body.id);
      }
      const [tc1, tc2, tc3] = createdTestCaseIds;

      // 2. Seed an "interrupted" run via the no-execution upsert:
      //    tc1 done (has a report id), tc2 pending, tc3 never scheduled.
      runId = `eval-run-resume-int-${Date.now()}`;
      const now = new Date().toISOString();
      const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        name: 'resume-int-run',
        sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        trigger: 'api',
        status: 'failed',
        error: 'simulated crash',
        createdAt: now,
        testCaseSnapshots: createdTestCaseIds.map((id, i) => ({ id, version: 1, name: `resume-int-tc${i + 1}` })),
        results: {
          [tc1]: { reportId: 'preserved-report-tc1', status: 'completed' },
          [tc2]: { reportId: '', status: 'pending' },
          // tc3 deliberately missing — crashed before it was scheduled
        },
      });
      expect(seeded.status).toBeLessThan(300);

      // 3. Resume — SSE stream until the run completes.
      const resume = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(resume.status).toBe(200);
      const events = parseSSE(resume.raw);

      const started = events.find((e) => e.event === 'started');
      expect(started).toBeDefined();
      expect(started!.data.resumed).toBe(true);
      expect(started!.data.pendingCount).toBe(2); // tc2 + tc3, NOT tc1

      const completed = events.find((e) => e.event === 'completed');
      expect(completed).toBeDefined();
      const finalRun = completed!.data;

      // 4. Completed checkpoint preserved byte-for-byte; unfinished re-executed.
      expect(finalRun.status).toBe('completed');
      expect(finalRun.resumedAt).toBeTruthy();
      expect(finalRun.results[tc1].reportId).toBe('preserved-report-tc1');
      expect(finalRun.results[tc2].reportId).toBeTruthy();
      expect(finalRun.results[tc2].reportId).not.toBe('preserved-report-tc1');
      expect(finalRun.results[tc3].reportId).toBeTruthy();
      for (const tcId of [tc2, tc3]) {
        createdReportIds.push(finalRun.results[tcId].reportId);
        expect(finalRun.results[tcId].status).toBe('completed');
      }

      // 5. Stats cover the FULL run (3), not just the resumed subset (2).
      expect(finalRun.stats?.total).toBe(3);

      // 6. Second resume: nothing left → 400.
      const again = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/nothing to resume/i);
    },
    TEST_TIMEOUT
  );

  it('404s for an unknown run id', async () => {
    if (!backendAvailable) return;
    const res = await httpJson('POST', `${BASE_URL}/api/storage/evaluation-runs/does-not-exist-xyz/resume`);
    expect(res.status).toBe(404);
  }, TEST_TIMEOUT);

  it('409s a second resume while the first is still executing (codex #2 — double-resume guard)', async () => {
    if (!backendAvailable) return;

    // Seed a second interrupted run over the same test cases.
    const raceRunId = `eval-run-resume-race-${Date.now()}`;
    const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}`, {
      name: 'resume-race-run',
      sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
      agentKey: 'demo',
      modelId: 'demo-model',
      judgeModelId: 'demo-model',
      trigger: 'api',
      status: 'failed',
      createdAt: new Date().toISOString(),
      testCaseSnapshots: createdTestCaseIds.map((id, i) => ({ id, version: 1, name: `race-tc${i + 1}` })),
      results: {},
    });
    expect(seeded.status).toBeLessThan(300);

    // Fire the first resume WITHOUT awaiting completion, then a second one.
    const first = httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}/resume`);
    await new Promise((r) => setTimeout(r, 1500)); // let the first claim + start
    const second = await httpJson<any>(`POST`, `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}/resume`);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/currently executing/i);

    // First resume runs to completion; collect its reports for cleanup.
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    const completed = parseSSE(firstRes.raw).find((e) => e.event === 'completed');
    expect(completed).toBeDefined();
    for (const v of Object.values<any>(completed!.data.results || {})) {
      if (v.reportId) createdReportIds.push(v.reportId);
    }
    await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}`).catch(() => {});
  }, TEST_TIMEOUT);
});
