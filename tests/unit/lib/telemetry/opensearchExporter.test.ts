/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for OpenSearchSpanExporter (lib/telemetry/opensearchExporter.ts)
 * — the OTel → OSIS document mapping (spanToDocument, private but exercised
 * through export()'s bulk-body capture) and the exporter lifecycle
 * (export/shutdown/forceFlush). The OpenSearch Client is mocked.
 */

import { ExportResultCode } from '@opentelemetry/core';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

const mockBulk = jest.fn();
const mockClose = jest.fn();
const MockClient = jest.fn().mockImplementation(() => ({
  bulk: mockBulk,
  close: mockClose,
}));

jest.mock('@opensearch-project/opensearch', () => ({
  Client: MockClient,
}));

import { OpenSearchSpanExporter } from '@/lib/telemetry/opensearchExporter';

function makeSpan(overrides: Partial<any> = {}): any {
  return {
    spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
    parentSpanContext: undefined,
    name: 'test-span',
    kind: SpanKind.INTERNAL,
    startTime: [1700000000, 0],
    endTime: [1700000001, 500_000_000],
    status: { code: SpanStatusCode.OK, message: '' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    attributes: { 'gen_ai.system': 'anthropic' },
    resource: { attributes: { 'service.name': 'my-service' } },
    events: [],
    links: [],
    ...overrides,
  };
}

describe('OpenSearchSpanExporter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBulk.mockResolvedValue({ body: { errors: false } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('constructs the underlying Client with basic auth and TLS settings', () => {
    new OpenSearchSpanExporter({
      endpoint: 'https://os.example.com', username: 'u', password: 'p', tlsSkipVerify: true,
    });

    expect(MockClient).toHaveBeenCalledWith({
      node: 'https://os.example.com',
      auth: { username: 'u', password: 'p' },
      ssl: { rejectUnauthorized: false },
    });
  });

  it('omits auth when username/password are not both provided, and defaults tlsSkipVerify to secure', () => {
    new OpenSearchSpanExporter({ endpoint: 'https://os.example.com' });
    expect(MockClient).toHaveBeenCalledWith({
      node: 'https://os.example.com',
      auth: undefined,
      ssl: { rejectUnauthorized: true },
    });
  });

  it('defaults indexName to otel-v1-apm-span-000001, honors an override', () => {
    const exporter1 = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    expect((exporter1 as any).indexName).toBe('otel-v1-apm-span-000001');

    const exporter2 = new OpenSearchSpanExporter({ endpoint: 'http://os', indexName: 'custom-index' });
    expect((exporter2 as any).indexName).toBe('custom-index');
  });

  it('export() is a no-op success when given an empty span array', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    exporter.export([], (result) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(mockBulk).not.toHaveBeenCalled();
      done();
    });
  });

  it('maps a root span (no real parent) to an OSIS document with traceGroupFields', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan();

    exporter.export([span], (result) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      const body = mockBulk.mock.calls[0][0].body;
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({ index: { _index: 'otel-v1-apm-span-000001', _id: 'trace-1/span-1' } });

      const doc = body[1];
      expect(doc.traceId).toBe('trace-1');
      expect(doc.spanId).toBe('span-1');
      expect(doc.parentSpanId).toBe('');
      expect(doc.kind).toBe('SPAN_KIND_INTERNAL');
      expect(doc.status).toEqual({ code: 1, message: '' });
      expect(doc.durationInNanos).toBe(1_500_000_000);
      expect(doc.attributes).toEqual({ 'gen_ai.system': 'anthropic' });
      expect(doc.resource).toEqual({ attributes: { 'service.name': 'my-service' } });
      expect(doc.serviceName).toBe('my-service');
      expect(doc.traceGroup).toBe('test-span');
      expect(doc.traceGroupFields).toEqual({
        endTime: expect.any(String), durationInNanos: 1_500_000_000, statusCode: 1,
      });
      expect(doc.events).toEqual([]);
      expect(doc.links).toEqual([]);
      done();
    });
  });

  it('a span with a real parent has no traceGroupFields and a populated parentSpanId', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({ parentSpanContext: { spanId: 'parent-span-1' } });

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.parentSpanId).toBe('parent-span-1');
      expect(doc.traceGroupFields).toBeUndefined();
      done();
    });
  });

  it('a parentSpanId of all zeros is treated as no real parent', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({ parentSpanContext: { spanId: '0000000000000000' } });

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.parentSpanId).toBe('');
      expect(doc.traceGroupFields).toBeDefined();
      done();
    });
  });

  it.each([
    [SpanKind.SERVER, 'SPAN_KIND_SERVER'],
    [SpanKind.CLIENT, 'SPAN_KIND_CLIENT'],
    [SpanKind.PRODUCER, 'SPAN_KIND_PRODUCER'],
    [SpanKind.CONSUMER, 'SPAN_KIND_CONSUMER'],
  ])('maps SpanKind %s to %s', (kind, expected, done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    exporter.export([makeSpan({ kind })], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.kind).toBe(expected);
      done();
    });
  });

  it.each([
    [SpanStatusCode.UNSET, 0],
    [SpanStatusCode.OK, 1],
    [SpanStatusCode.ERROR, 2],
  ])('maps SpanStatusCode %s to %d', (code, expected, done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    exporter.export([makeSpan({ status: { code, message: 'x' } })], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.status).toEqual({ code: expected, message: 'x' });
      done();
    });
  });

  it('maps events with attributes, and defaults droppedAttributesCount', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({
      events: [
        { name: 'tool.output', time: [1700000000, 0], attributes: { 'tool.name': 'grep' } },
        { name: 'no-attrs-event', time: [1700000000, 0] },
      ],
    });

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.events).toHaveLength(2);
      expect(doc.events[0]).toEqual(expect.objectContaining({ name: 'tool.output', droppedAttributesCount: 0, attributes: { 'tool.name': 'grep' } }));
      expect(doc.events[1].attributes).toBeUndefined();
      done();
    });
  });

  it('maps links with traceState/attributes, defaulting when absent', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({
      links: [
        { context: { traceId: 't2', spanId: 's2', traceState: { serialize: () => 'k=v' } }, attributes: { a: 1 }, droppedAttributesCount: 2 },
        { context: { traceId: 't3', spanId: 's3' } },
      ],
    });

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.links[0]).toEqual({ traceId: 't2', spanId: 's2', traceState: 'k=v', attributes: { a: 1 }, droppedAttributesCount: 2 });
      expect(doc.links[1]).toEqual({ traceId: 't3', spanId: 's3', traceState: '', attributes: {}, droppedAttributesCount: 0 });
      done();
    });
  });

  it('falls back to instrumentationLibrary and "unknown" serviceName when absent', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({ resource: { attributes: {} }, instrumentationLibrary: { name: 'legacy-lib', version: '1.0' } });
    delete (span as any).instrumentationScope;

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.serviceName).toBe('unknown');
      expect(doc.instrumentationScope).toEqual({ name: 'legacy-lib', version: '1.0' });
      done();
    });
  });

  it('drops undefined-valued span/resource attributes', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    const span = makeSpan({
      attributes: { keep: 'yes', drop: undefined },
      resource: { attributes: { keep: 'r', drop: undefined } },
    });

    exporter.export([span], () => {
      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.attributes).toEqual({ keep: 'yes' });
      expect(doc.resource).toEqual({ attributes: { keep: 'r' } });
      done();
    });
  });

  it('logs and calls FAILED when bulk() rejects', (done) => {
    mockBulk.mockRejectedValue(new Error('cluster unreachable'));
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });

    exporter.export([makeSpan()], (result) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(console.error).toHaveBeenCalledWith('[Telemetry] OpenSearch export failed:', 'cluster unreachable');
      done();
    });
  });

  it('warns (but still succeeds) when the bulk response reports per-item errors', (done) => {
    mockBulk.mockResolvedValue({
      body: {
        errors: true,
        items: [
          { index: { error: { type: 'mapper_parsing_exception', reason: 'bad field' } } },
          { index: {} },
        ],
      },
    });
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });

    exporter.export([makeSpan()], (result) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('1 error(s)'),
        'mapper_parsing_exception: bad field',
      );
      done();
    });
  });

  it('rejects any export() call after shutdown() with FAILED', (done) => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    exporter.shutdown().then(() => {
      expect(mockClose).toHaveBeenCalled();
      exporter.export([makeSpan()], (result) => {
        expect(result.code).toBe(ExportResultCode.FAILED);
        expect(mockBulk).not.toHaveBeenCalled();
        done();
      });
    });
  });

  it('forceFlush() resolves without doing anything (no buffering)', async () => {
    const exporter = new OpenSearchSpanExporter({ endpoint: 'http://os' });
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });
});
