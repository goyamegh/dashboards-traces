/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import {
  EXPORT_FAILURE_LOG_INTERVAL_MS,
  MonitoredSpanExporter,
  describeExportError,
  normalizeOtlpTracesEndpoint,
} from '@/lib/telemetry/exportMonitor';

describe('normalizeOtlpTracesEndpoint', () => {
  it.each([
    ['https://abc123.execute-api.us-east-1.amazonaws.com', 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/traces'],
    ['https://abc123.execute-api.us-east-1.amazonaws.com/', 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/traces'],
    ['http://localhost:4318', 'http://localhost:4318/v1/traces'],
    ['http://127.0.0.1:4318?x=1', 'http://127.0.0.1:4318/v1/traces?x=1'],
  ])('appends /v1/traces to a base url with no path: %s', (input, expected) => {
    expect(normalizeOtlpTracesEndpoint(input)).toEqual({ url: expected, appendedPath: true });
  });

  it.each([
    'http://localhost:4318/v1/traces',
    'https://pipeline.example.osis.amazonaws.com/otel-trace-abc/v1/traces',
    'https://collector.example.com/custom/ingest',
    'https://collector.example.com/v1/traces/',
  ])('leaves a url that already carries a path untouched: %s', (input) => {
    expect(normalizeOtlpTracesEndpoint(input)).toEqual({ url: input, appendedPath: false });
  });

  it('returns unparseable input unchanged so the exporter reports its own error', () => {
    expect(normalizeOtlpTracesEndpoint('not a url')).toEqual({ url: 'not a url', appendedPath: false });
    expect(normalizeOtlpTracesEndpoint('')).toEqual({ url: '', appendedPath: false });
  });
});

describe('describeExportError', () => {
  it('renders the OTLP exporter error (HTTP status + body) and plain socket errors', () => {
    expect(describeExportError(Object.assign(new Error('Not Found'), { code: 404, data: '{"message":"Not Found"}' })))
      .toBe('HTTP 404 Not Found {"message":"Not Found"}');
    expect(describeExportError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })))
      .toBe('connect ECONNREFUSED 127.0.0.1:1 ECONNREFUSED');
    expect(describeExportError(undefined)).toBe('unknown error');
    // An HTML error page (Express default 404) is flattened to one bounded line.
    expect(describeExportError(Object.assign(new Error('Not Found'), { code: 404, data: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /wrong</pre>\n</body>\n</html>\n' })))
      .toBe('HTTP 404 Not Found Error Cannot POST /wrong');
    expect(describeExportError(Object.assign(new Error('Forbidden'), { code: 403, data: 'x'.repeat(300) })))
      .toBe(`HTTP 403 Forbidden ${'x'.repeat(160)}…`);
  });
});

function stubExporter(results: ExportResult[]): SpanExporter & { calls: number; shutdowns: number; flushes: number } {
  const stub = {
    calls: 0, shutdowns: 0, flushes: 0,
    export(_spans: ReadableSpan[], cb: (r: ExportResult) => void) { cb(results[Math.min(stub.calls++, results.length - 1)]); },
    shutdown() { stub.shutdowns++; return Promise.resolve(); },
    forceFlush() { stub.flushes++; return Promise.resolve(); },
  };
  return stub;
}
const spans = (n: number) => Array.from({ length: n }, () => ({} as ReadableSpan));
const ok: ExportResult = { code: ExportResultCode.SUCCESS };
const notFound: ExportResult = { code: ExportResultCode.FAILED, error: Object.assign(new Error('Not Found'), { code: 404, data: '{"message":"Not Found"}' }) };

describe('MonitoredSpanExporter', () => {
  it('counts acknowledged spans and forwards the inner result untouched', () => {
    const inner = stubExporter([ok]);
    const mon = new MonitoredSpanExporter(inner, 'otlp', 'http://x/v1/traces', () => 1_000);
    const seen: ExportResult[] = [];
    mon.export(spans(3), (r) => seen.push(r));
    mon.export(spans(2), (r) => seen.push(r));
    expect(seen).toEqual([ok, ok]);
    expect(mon.getStatus()).toEqual({
      exporter: 'otlp', endpoint: 'http://x/v1/traces', exportedSpans: 5, failedBatches: 0, droppedSpans: 0,
      lastError: undefined, lastSuccessAt: new Date(1_000).toISOString(),
    });
  });

  it('records failed batches with the exporter error, logs the first failure, then throttles to one line per interval', () => {
    let now = 10_000;
    const lines: string[] = [];
    const inner = stubExporter([notFound]);
    const mon = new MonitoredSpanExporter(inner, 'otlp', 'https://gw.example.com', () => now, (l) => lines.push(l));

    mon.export(spans(1), () => {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Eval span export FAILED → https:\/\/gw\.example\.com: HTTP 404 Not Found/);
    expect(lines[0]).toMatch(/1 span\(s\) dropped; 1 total/);
    expect(lines[0]).toMatch(/\/v1\/traces/);

    now += 1_000; mon.export(spans(2), () => {});
    now += 1_000; mon.export(spans(1), () => {});
    expect(lines).toHaveLength(1); // suppressed within the interval

    now += EXPORT_FAILURE_LOG_INTERVAL_MS; mon.export(spans(1), () => {});
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/5 total, 2 earlier failure\(s\) not logged/);

    expect(mon.getStatus()).toMatchObject({
      exportedSpans: 0, failedBatches: 4, droppedSpans: 5,
      lastError: { at: new Date(now).toISOString(), message: 'HTTP 404 Not Found {"message":"Not Found"}' },
    });
  });

  it('a success after failures keeps the failure history but stamps lastSuccessAt', () => {
    const inner = stubExporter([notFound, ok]);
    const mon = new MonitoredSpanExporter(inner, 'opensearch', 'https://os.example.com', () => 5_000, () => {});
    mon.export(spans(1), () => {});
    mon.export(spans(1), () => {});
    expect(mon.getStatus()).toMatchObject({ exporter: 'opensearch', exportedSpans: 1, failedBatches: 1, droppedSpans: 1, lastSuccessAt: new Date(5_000).toISOString() });
    expect(mon.getStatus().lastError?.message).toMatch(/404/);
  });

  it('getStatus returns a copy (callers cannot mutate the counters)', () => {
    const mon = new MonitoredSpanExporter(stubExporter([notFound]), 'otlp', 'u', () => 0, () => {});
    mon.export(spans(1), () => {});
    const a = mon.getStatus();
    a.exportedSpans = 99; a.lastError!.message = 'tampered';
    expect(mon.getStatus().exportedSpans).toBe(0);
    expect(mon.getStatus().lastError?.message).toMatch(/404/);
  });

  it('delegates shutdown and forceFlush to the inner exporter (and tolerates one without forceFlush)', async () => {
    const inner = stubExporter([ok]);
    const mon = new MonitoredSpanExporter(inner, 'otlp', 'u');
    await mon.forceFlush(); await mon.shutdown();
    expect(inner.flushes).toBe(1); expect(inner.shutdowns).toBe(1);
    const noFlush = { export: inner.export, shutdown: () => Promise.resolve() } as SpanExporter;
    await expect(new MonitoredSpanExporter(noFlush, 'otlp', 'u').forceFlush()).resolves.toBeUndefined();
  });
});
