/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for scripts/smoke-telemetry.ts — the telemetry smoke gate — run as a
 * real subprocess against an in-process mock backend so the SSE flow, every
 * check's PASS / FAIL / SKIP branch and the exit code are exercised. Synthetic
 * fixtures only; the mock backend is parameterised per test.
 */

import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'smoke-telemetry.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');

interface Scenario {
  connectorType: string;
  report: Record<string, unknown>;
  spans: number;
  metrics: 'ok' | 'no-spans' | 'eval-only' | 'unconfigured';
  evaluateEvents?: Array<Record<string, unknown>>;
  /**
   * What GET /health reports under `telemetry`, per call (first = preflight,
   * second = after the run). `undefined` = a server that predates the field.
   */
  health?: Array<Record<string, unknown>>;
}

interface MockBackend { server: Server; url: string; deletes: string[]; tracesBodies: any[] }

function startMockBackend(s: Scenario): Promise<MockBackend> {
  const deletes: string[] = [];
  const tracesBodies: any[] = [];
  let healthCalls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const readBody = () => new Promise<any>((r) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { try { r(JSON.parse(raw || '{}')); } catch { r({}); } }); });

    if (path === '/health') {
      const telemetry = s.health?.[Math.min(healthCalls++, (s.health?.length ?? 1) - 1)];
      return send(200, { status: 'ok', ...(telemetry ? { telemetry } : {}) });
    }
    if (path === '/api/agents') return send(200, { agents: [{ key: 'example-agent', connectorType: s.connectorType }], total: 1 });
    if (path === '/api/models') return send(200, { models: [{ key: 'judge-model' }] });
    if (path === '/api/evaluate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = s.evaluateEvents ?? [{ type: 'started', reportId: 'rep-smoke' }, { type: 'step', stepIndex: 0 }, { type: 'completed', reportId: 'rep-smoke' }];
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      return res.end();
    }
    if (path === '/api/storage/runs/rep-smoke') {
      if (req.method === 'DELETE') { deletes.push(path); return send(200, { deleted: true }); }
      return send(200, { id: 'rep-smoke', status: 'completed', connectorProtocol: s.connectorType, ...s.report });
    }
    if (path === '/api/traces' && req.method === 'POST') {
      return readBody().then((b) => { tracesBodies.push(b); send(200, { spans: Array.from({ length: s.spans }, (_, i) => ({ spanId: `s${i}` })), total: s.spans, backend: 'file' }); });
    }
    if (path === '/api/metrics/batch' && req.method === 'POST') {
      if (s.metrics === 'unconfigured') return send(503, { error: 'Observability data source not configured' });
      return readBody().then((b) => send(200, {
        metrics: (b.runIds as string[]).map((k) => s.metrics === 'ok'
          ? { runId: k, hasSpans: true, totalTokens: 1234, llmCalls: 3, costUsd: 0.01, status: 'success' }
          : s.metrics === 'eval-only'
            ? { runId: k, hasSpans: false, evalOnlySpans: 1, totalTokens: 0, llmCalls: 0, costUsd: 0, status: 'pending' }
            : { runId: k, hasSpans: false, totalTokens: 0, llmCalls: 0, costUsd: 0, status: 'pending' }),
        aggregate: {},
      }));
    }
    send(404, { error: `unhandled ${req.method} ${path}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, deletes, tracesBodies });
    });
  });
}

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, [SCRIPT, ...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === 'number' ? (error as any).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const parse = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf('{')));
const statusOf = (r: any, name: RegExp) => r.checks.find((c: any) => name.test(c.name))?.status;

describe('scripts/smoke-telemetry.ts', () => {
  let backend: MockBackend | undefined;
  afterEach(async () => { if (backend) await new Promise<void>((r) => backend!.server.close(() => r())); backend = undefined; });

  it('PASSes (exit 0) for a REST agent whose report carries traceId + runId, spans are found and metrics correlate; cleans up its report', async () => {
    backend = await startMockBackend({ connectorType: 'rest', report: { traceId: 'abc', runId: 'echoed-1' }, spans: 3, metrics: 'ok' });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(0);
    expect(r.ok).toBe(true);
    // Check 5 is SKIP: this backend predates the /health `telemetry` block.
    expect(r.checks.map((c: any) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'SKIP']);
    expect(r.spansFound).toBe(3);
    // Correlates by A OR B: both ids sent to /api/traces.
    expect(backend.tracesBodies[0]).toMatchObject({ traceId: 'abc', runIds: ['echoed-1'] });
    // Cleanup of the one report it created.
    expect(backend.deletes).toEqual(['/api/storage/runs/rep-smoke']);
  }, 90_000);

  it('FAILs (exit 1) when the eval span is off (no traceId) and no spans are found — the real-world failure mode', async () => {
    backend = await startMockBackend({ connectorType: 'mock', report: { runId: 'mock-run-1' }, spans: 0, metrics: 'unconfigured' });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(1);
    expect(statusOf(r, /traceId/)).toBe('FAIL');
    expect(statusOf(r, /runId/)).toBe('SKIP'); // not a REST connector
    expect(statusOf(r, /spans found/)).toBe('FAIL');
    expect(statusOf(r, /metrics/)).toBe('SKIP'); // no observability cluster
  }, 90_000);

  it('FAILs a REST agent whose report has a traceId but NO runId (the echoed id was not mapped), unless --allow-no-run-id downgrades it to WARN', async () => {
    backend = await startMockBackend({ connectorType: 'rest', report: { traceId: 'abc' }, spans: 2, metrics: 'ok' });
    const strict = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    expect(strict.code).toBe(1);
    expect(statusOf(parse(strict.stdout), /runId/)).toBe('FAIL');

    const lenient = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--allow-no-run-id', '--json']);
    expect(lenient.code).toBe(0);
    expect(statusOf(parse(lenient.stdout), /runId/)).toBe('WARN');
  }, 120_000);

  it('FAILs when spans are found by the Traces API but the metrics reader does not correlate (hasSpans=false) — the exact parity gap', async () => {
    backend = await startMockBackend({ connectorType: 'rest', report: { traceId: 'abc', runId: 'r' }, spans: 5, metrics: 'no-spans' });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(1);
    expect(statusOf(r, /spans found/)).toBe('PASS');
    expect(statusOf(r, /metrics/)).toBe('FAIL');
  }, 90_000);

  it('agent DOWN (report.failureStage=agent): runId + metrics become WARN "agent unreachable", the eval span is still required (PASS → exit 0)', async () => {
    const telemetryOk = (exported: number) => ({ enabled: true, exporter: 'otlp', exportedSpans: exported, failedBatches: 0, droppedSpans: 0, endpoint: 'http://127.0.0.1:1/v1/traces' });
    backend = await startMockBackend({
      connectorType: 'rest',
      report: { traceId: 'abc', status: 'failed', failureStage: 'agent', error: 'Agent request to POST http://127.0.0.1:1/ask failed after 2ms: ECONNREFUSED', agentError: { kind: 'connection' } },
      spans: 1, metrics: 'eval-only',
      health: [telemetryOk(4), telemetryOk(5)],
    });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(0);
    expect(r.agentFailure).toMatch(/ECONNREFUSED/);
    expect(statusOf(r, /traceId/)).toBe('PASS');
    expect(statusOf(r, /runId/)).toBe('WARN');
    expect(r.checks.find((c: any) => /runId/.test(c.name)).detail).toMatch(/agent unreachable/);
    expect(statusOf(r, /spans found/)).toBe('PASS');
    expect(statusOf(r, /metrics/)).toBe('WARN');
    expect(r.checks.find((c: any) => /metrics/.test(c.name)).detail).toMatch(/agent unreachable — no agent spans expected \(1 eval span\(s\) matched\)/);
    expect(statusOf(r, /eval span export/)).toBe('PASS');
    expect(r.checks.find((c: any) => /eval span export/.test(c.name)).detail).toMatch(/1 span\(s\) acknowledged → http:\/\/127\.0\.0\.1:1\/v1\/traces/);
  }, 90_000);

  it('agent DOWN but the eval span never arrives: check 3 stays FAIL and check 5 names the exporter error (exit 1)', async () => {
    backend = await startMockBackend({
      connectorType: 'rest',
      report: { traceId: 'abc', status: 'failed', failureStage: 'agent', error: 'ECONNREFUSED' },
      spans: 0, metrics: 'no-spans',
      health: [
        { enabled: true, exporter: 'otlp', exportedSpans: 0, failedBatches: 2, droppedSpans: 2 },
        { enabled: true, exporter: 'otlp', exportedSpans: 0, failedBatches: 3, droppedSpans: 3, lastError: { at: '2026-01-01T00:00:00.000Z', message: 'HTTP 404 Not Found {"message":"Not Found"}' } },
      ],
    });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(1);
    expect(statusOf(r, /spans found/)).toBe('FAIL');
    expect(statusOf(r, /metrics/)).toBe('WARN'); // agent down: no agent spans expected
    expect(statusOf(r, /eval span export/)).toBe('FAIL');
    expect(r.checks.find((c: any) => /eval span export/.test(c.name)).detail).toMatch(/1 export batch\(es\) failed during this run: HTTP 404 Not Found/);
  }, 90_000);

  it('agent UP but it emitted nothing (metrics matched only the eval span): check 4 stays FAIL and says so', async () => {
    backend = await startMockBackend({ connectorType: 'rest', report: { traceId: 'abc', runId: 'r' }, spans: 1, metrics: 'eval-only', health: [{ enabled: false }] });
    const { code, stdout } = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--json']);
    const r = parse(stdout);
    expect(code).toBe(1);
    expect(statusOf(r, /metrics/)).toBe('FAIL');
    expect(r.checks.find((c: any) => /metrics/.test(c.name)).detail).toMatch(/only Agent Health's own 1 eval span\(s\) matched/);
    expect(statusOf(r, /eval span export/)).toBe('FAIL'); // telemetry disabled on the server
  }, 90_000);

  it('--keep leaves the report in place; unknown agent / flag exit 2', async () => {
    backend = await startMockBackend({ connectorType: 'rest', report: { traceId: 'abc', runId: 'r' }, spans: 1, metrics: 'ok' });
    const kept = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--spans-wait-ms', '0', '--keep', '--json']);
    expect(kept.code).toBe(0);
    expect(backend.deletes).toEqual([]);

    const noAgent = await runScript(['--base', backend.url, '--agent-key', 'nope']);
    expect(noAgent.code).toBe(2);
    expect(noAgent.stderr).toMatch(/Agent "nope" not found/);
    const badFlag = await runScript(['--base', backend.url, '--agent-key', 'example-agent', '--nope']);
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toMatch(/Unknown flag/);
  }, 120_000);
});
