/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the eval `test_case` span is exported on the AGENT-FAILURE path
 * and reaches an OTLP/HTTP receiver — REAL server process (`server/dist/index.js`,
 * file storage, demo judge), REAL `@opentelemetry/sdk-trace-node` +
 * `@opentelemetry/exporter-trace-otlp-http`, exporting to a local HTTP receiver
 * this test runs. No SDK mocks. (The exporter cannot run in-process under
 * jest's CJS VM — it needs a dynamic import — so the real server is spawned.)
 *
 * Cases, each via POST /api/evaluate against a REST agent:
 *   (b) agent unreachable (ECONNREFUSED)        → report.failureStage 'agent'
 *   (c) agent accepts and never answers (timeout) → report.failureStage 'agent'
 * In both, the `test_case` span must arrive with `traceId === report.traceId`
 * and `/health → telemetry.exportedSpans` must count it.
 *
 * Plus the 2026-10-24 silent-failure modes (eval spans vanished with a clean
 * server log once the live server inherited the OTel BASE url
 * `OTEL_EXPORTER_OTLP_ENDPOINT=https://<gateway>` as its traces url):
 *   - server A's exporter endpoint is the receiver's BASE url (no path): the
 *     provider must complete it to `/v1/traces` (red on the old code: every
 *     batch hit `/` → 404 → 0 spans).
 *   - server B's endpoint is a path the receiver rejects: `/health → telemetry`
 *     must count the failed batch with the HTTP error, and the server log must
 *     carry one `[Telemetry] Eval span export FAILED` line (red on the old
 *     code: no counters, nothing logged).
 *
 * Needs `npm run build:server` (CI's integration job starts the same bundle).
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import * as os from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const SERVER_ENTRY = join(ROOT, 'server/dist/index.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── local OTLP/JSON receiver ────────────────────────────────────────────────
interface ReceivedSpan { name: string; traceId: string; status: number; attrs: Record<string, unknown> }
interface Receiver { server: Server; port: number; url: string; requests: Array<{ path: string; status: number }>; spans: ReceivedSpan[] }

/** 200 on POST /v1/traces; 404 {"message":"Not Found"} elsewhere (what an API-Gateway-fronted pipeline answers at `/`). */
function startReceiver(): Promise<Receiver> {
  const rx = { requests: [], spans: [] } as unknown as Receiver;
  rx.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url || '/';
      if (req.method !== 'POST' || !/^\/v1\/traces\/?$/.test(path)) {
        rx.requests.push({ path, status: 404 });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const rs of body.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
        const attrs: Record<string, unknown> = {};
        for (const a of s.attributes ?? []) attrs[a.key] = a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue ?? a.value?.boolValue;
        rx.spans.push({ name: s.name, traceId: s.traceId, status: s.status?.code ?? 0, attrs });
      }
      rx.requests.push({ path, status: 200 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {} }));
    });
  });
  return new Promise((resolve) => rx.server.listen(0, '127.0.0.1', () => {
    rx.port = (rx.server.address() as { port: number }).port;
    rx.url = `http://127.0.0.1:${rx.port}`;
    resolve(rx);
  }));
}

/** Accepts the connection and request, never answers — the connector-timeout case. */
function startHangingAgent(): Promise<{ server: Server; port: number; hits: number }> {
  const state = { hits: 0 } as { server: Server; port: number; hits: number };
  state.server = createServer((req) => { state.hits++; req.on('data', () => {}); });
  return new Promise((resolve) => state.server.listen(0, '127.0.0.1', () => {
    state.port = (state.server.address() as { port: number }).port;
    resolve(state);
  }));
}

async function reserveClosedPort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port)));
  await new Promise<void>((r) => s.close(() => r()));
  return port; // nothing listens here any more → ECONNREFUSED
}

// ─── real server child ───────────────────────────────────────────────────────
interface ServerChild { child: ChildProcess; port: number; base: string; dir: string; output: () => string }

async function startServer(opts: { exporterEndpoint: string; downPort: number; hangPort: number }): Promise<ServerChild> {
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Missing ${SERVER_ENTRY}; run npm run build:server first`);
  const dir = mkdtempSync(join(os.tmpdir(), 'evalspan-int-'));
  const port = await reserveClosedPort();
  // Synthetic, local-only config: demo judge (no LLM), two REST agents.
  writeFileSync(join(dir, 'agent-health.config.mjs'), `export default {
  extends: false,
  telemetry: { enabled: true, exporterEndpoint: ${JSON.stringify(opts.exporterEndpoint)}, serviceName: 'agent-health' },
  models: [{ key: 'demo-judge', model_id: 'demo-judge', display_name: 'Demo judge', provider: 'demo', context_window: 100000, max_output_tokens: 1024 }],
  agents: [
    { key: 'down-rest', name: 'Down REST agent', endpoint: 'http://127.0.0.1:${opts.downPort}/ask', connectorType: 'rest', useTraces: false, connectorConfig: { timeoutMs: 5000 } },
    { key: 'hang-rest', name: 'Hanging REST agent', endpoint: 'http://127.0.0.1:${opts.hangPort}/ask', connectorType: 'rest', useTraces: false, connectorConfig: { timeoutMs: 2000 } },
  ],
};
`);
  // File storage: strip any cluster / OTel vars inherited from the runner.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(OPENSEARCH_|OTEL_|AGENT_HEALTH_|AH_PORT$|PORT$)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { AH_PORT: String(port), PORT: String(port), BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1' });
  let output = '';
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (c) => { output += c; });
  child.stderr?.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${output}`);
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        const h = await r.json() as { instance?: { pid?: number } };
        if (h.instance?.pid === child.pid) break;
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return { child, port, base, dir, output: () => output };
}

async function stopServer(s: ServerChild | undefined): Promise<void> {
  if (!s) return;
  if (s.child.exitCode === null) {
    s.child.kill('SIGTERM'); // our own child, by handle
    const deadline = Date.now() + 10_000;
    while (s.child.exitCode === null && s.child.signalCode === null && Date.now() < deadline) await sleep(50);
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGKILL');
  }
  rmSync(s.dir, { recursive: true, force: true });
}

// ─── one ad-hoc evaluation (the smoke's path) ────────────────────────────────
async function evaluate(base: string, agentKey: string, label: string): Promise<Record<string, any>> {
  const now = new Date().toISOString();
  const prompt = 'Reply with the single word OK.';
  const res = await fetch(`${base}/api/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentKey, modelId: 'demo-judge', runName: `evalspan ${label}`,
      testCase: {
        id: `evalspan-${label}-${Date.now()}`, name: `evalspan-${label}`, description: 'integration', category: 'Smoke', difficulty: 'Easy', currentVersion: 1,
        versions: [{ version: 1, createdAt: now, initialPrompt: prompt, context: [], expectedOutcomes: ['Any reply at all.'] }],
        initialPrompt: prompt, context: [], expectedOutcomes: ['Any reply at all.'], createdAt: now, updatedAt: now,
      },
    }),
  });
  expect(res.ok).toBe(true);
  let reportId: string | undefined;
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  outer: for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: ')); if (!line) continue;
      let ev: any; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === 'started' && ev.reportId) reportId = ev.reportId;
      if (ev.type === 'completed' || ev.type === 'error') { reportId = ev.reportId ?? reportId; break outer; }
    }
  }
  expect(reportId).toBeDefined();
  let report: any = {};
  for (let i = 0; i < 20; i++) {
    report = await (await fetch(`${base}/api/storage/runs/${encodeURIComponent(reportId!)}`)).json();
    if (report?.status && report.status !== 'running') break;
    await sleep(500);
  }
  return report;
}

async function waitForSpans(rx: Receiver, predicate: (s: ReceivedSpan) => boolean, timeoutMs = 20_000): Promise<ReceivedSpan[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = rx.spans.filter(predicate);
    if (found.length || Date.now() >= deadline) return found;
    await sleep(250);
  }
}

const health = async (base: string) => (await (await fetch(`${base}/health`)).json()) as any;

describe('eval test_case span on agent failure → real server → real OTLP exporter → local receiver (integration)', () => {
  let rx: Receiver;
  let hang: { server: Server; port: number; hits: number };
  let downPort: number;
  let server: ServerChild | undefined;

  beforeAll(async () => {
    rx = await startReceiver();
    hang = await startHangingAgent();
    downPort = await reserveClosedPort();
  });

  afterEach(async () => { await stopServer(server); server = undefined; });

  afterAll(async () => {
    await new Promise<void>((r) => rx.server.close(() => r()));
    hang.server.closeAllConnections?.();
    await new Promise<void>((r) => hang.server.close(() => r()));
  });

  describe('server A — exporter endpoint is the receiver BASE url (no path)', () => {
    it('completes the url to /v1/traces; cases (b) ECONNREFUSED and (c) timeout export a test_case span whose traceId equals report.traceId; /health counts them', async () => {
      server = await startServer({ exporterEndpoint: rx.url, downPort, hangPort: hang.port });

      // (b) agent unreachable
      const b = await evaluate(server.base, 'down-rest', 'b');
      expect(b).toMatchObject({ status: 'failed', failureStage: 'agent' });
      expect(b.error).toMatch(/ECONNREFUSED/);
      expect(b.traceId).toMatch(/^[0-9a-f]{32}$/);
      const bSpans = await waitForSpans(rx, (s) => s.attrs['test.case.name'] === 'evalspan-b');
      // Old provider: the batch was POSTed to `/` → 404 → nothing here.
      expect({ spans: bSpans.length, requests: rx.requests }).toEqual({ spans: 1, requests: [{ path: '/v1/traces', status: 200 }] });
      expect(server.output()).toMatch(/\[Telemetry\] Exporter endpoint http:\/\/127\.0\.0\.1:\d+ has no path; using http:\/\/127\.0\.0\.1:\d+\/v1\/traces/);
      expect(bSpans[0]).toMatchObject({ name: 'test_case', traceId: b.traceId, status: 2 /* ERROR */ });
      expect(bSpans[0].attrs).toMatchObject({ 'test.case.result.status': 'fail', 'agent_health.connector.protocol': 'rest' });

      // (c) agent accepts the request and never answers
      const c = await evaluate(server.base, 'hang-rest', 'c');
      expect(c).toMatchObject({ status: 'failed', failureStage: 'agent' });
      expect(c.error).toMatch(/timed out after \d+ms \(timeout 2000ms\)/);
      expect(hang.hits).toBeGreaterThanOrEqual(1);
      const cSpans = await waitForSpans(rx, (s) => s.attrs['test.case.name'] === 'evalspan-c');
      expect(cSpans).toHaveLength(1);
      expect(cSpans[0]).toMatchObject({ name: 'test_case', traceId: c.traceId, status: 2 });
      expect(Number(cSpans[0].attrs['agent_health.agent.duration_ms'])).toBeGreaterThanOrEqual(2000);

      // Every export hit the completed path, none the base url.
      expect(rx.requests.every((r) => r.path === '/v1/traces' && r.status === 200)).toBe(true);
      expect((await health(server.base)).telemetry).toMatchObject({ exportedSpans: 2, failedBatches: 0, droppedSpans: 0 });
      expect(server.output()).not.toMatch(/Eval span export FAILED/);
    }, 120_000);
  });

  describe('server B — exporter endpoint is a path the receiver rejects (HTTP 404)', () => {
    it('the report still carries a traceId, but /health → telemetry counts the failed batch with the HTTP error and the log names it', async () => {
      const before = rx.requests.length;
      server = await startServer({ exporterEndpoint: `${rx.url}/wrong/path`, downPort, hangPort: hang.port });
      expect(server.output()).not.toMatch(/has no path/);

      const b = await evaluate(server.base, 'down-rest', 'b2');
      expect(b).toMatchObject({ status: 'failed', failureStage: 'agent' });
      expect(b.traceId).toMatch(/^[0-9a-f]{32}$/);

      // The exporter flushes on its own schedule (BatchSpanProcessor, ≤5 s).
      const deadline = Date.now() + 20_000;
      let t: any;
      do { t = (await health(server.base)).telemetry; if (t.failedBatches >= 1) break; await sleep(250); } while (Date.now() < deadline);
      expect(t).toMatchObject({ enabled: true, exporter: 'otlp', endpoint: `${rx.url}/wrong/path`, exportedSpans: 0, failedBatches: 1, droppedSpans: 1 });
      expect(t.lastError.message).toMatch(/HTTP 404 Not Found/);
      expect(rx.requests.slice(before)).toEqual([{ path: '/wrong/path', status: 404 }]);
      expect(rx.spans.some((s) => s.traceId === b.traceId)).toBe(false);
      expect(server.output()).toMatch(new RegExp(`\\[Telemetry\\] Eval span export FAILED → ${rx.url.replace(/[.]/g, '\\.')}/wrong/path: HTTP 404 Not Found`));
    }, 120_000);
  });
});
