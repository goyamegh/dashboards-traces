/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the zero-dependency pi profiling distribution extension's pure
 * helpers (examples/pi-profiling/agent-health-profile.ts). The extension's
 * default export (I/O wiring) is exercised by the integration test; here we pin
 * the OTLP span shaping + command/arg parsing that the rest of the pipeline
 * depends on.
 */

import {
  PI_SERVICE_NAME,
  DEFAULT_ENDPOINT,
  DEFAULT_EVALUATOR,
  REDACTED,
  randomHex,
  genTraceId,
  genSpanId,
  parseTraceparent,
  resolveEndpoint,
  sessionIdFromFile,
  numOrUndef,
  truncate,
  safeStringify,
  extractText,
  parseFlag,
  buildProfileInvocation,
  extractJson,
  buildOtlpPayload,
  buildRootSpan,
  buildChatSpan,
  buildToolSpan,
  msToNanos,
} from '../../../examples/pi-profiling/agent-health-profile';

const T = { startNs: msToNanos(1000), endNs: msToNanos(2000) };

describe('pi profiling distribution extension — pure helpers', () => {
  describe('id + traceparent', () => {
    it('generates valid hex ids of the right length', () => {
      expect(genTraceId()).toMatch(/^[0-9a-f]{32}$/);
      expect(genSpanId()).toMatch(/^[0-9a-f]{16}$/);
      expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
    });
    it('parses a W3C traceparent and rejects junk', () => {
      expect(parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'))
        .toEqual({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' });
      expect(parseTraceparent('garbage')).toBeNull();
      expect(parseTraceparent(undefined)).toBeNull();
    });
  });

  describe('resolveEndpoint', () => {
    it('defaults to localhost:4001 and appends /v1/traces', () => {
      expect(resolveEndpoint(undefined)).toBe(`${DEFAULT_ENDPOINT}/v1/traces`);
    });
    it('does not double-append /v1/traces and trims trailing slash', () => {
      expect(resolveEndpoint('https://gw.example.com/')).toBe('https://gw.example.com/v1/traces');
      expect(resolveEndpoint('https://gw.example.com/v1/traces')).toBe('https://gw.example.com/v1/traces');
    });
  });

  describe('misc pure helpers', () => {
    it('sessionIdFromFile derives a stem; undefined for ephemeral', () => {
      expect(sessionIdFromFile('/x/y/abc-123.jsonl')).toBe('abc-123');
      expect(sessionIdFromFile(undefined)).toBeUndefined();
    });
    it('numOrUndef / truncate / safeStringify', () => {
      expect(numOrUndef('5')).toBe(5);
      expect(numOrUndef('x')).toBeUndefined();
      expect(truncate('abcdef', 3)).toBe('abc…');
      expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    });
    it('extractText joins text blocks, ignores others', () => {
      expect(extractText('hi')).toBe('hi');
      expect(extractText([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
      expect(extractText([])).toBeUndefined();
    });
    it('parseFlag (quoted + bare) and buildProfileInvocation', () => {
      expect(parseFlag('-e my-eval', ['-e', '--evaluator'])).toBe('my-eval');
      expect(parseFlag('-f "focus here"', ['-f', '--feedback'])).toBe('focus here');
      const { bin, args } = buildProfileInvocation({ sessionId: 's1' });
      expect(bin).toBe('npx');
      expect(args).toEqual(['@opensearch-project/agent-health', 'profile', '-e', DEFAULT_EVALUATOR, '--session', 's1', '--service', PI_SERVICE_NAME, '--output', 'json']);
    });
    it('extractJson tolerates leading log lines, returns null on junk', () => {
      expect(extractJson('log\n{"a":1}\n')).toEqual({ a: 1 });
      expect(extractJson('nope')).toBeNull();
    });
  });

  describe('OTLP span builders', () => {
    const base = { traceId: genTraceId(), sessionId: 'sess-1', times: T };

    it('root span: invoke_agent + session.id', () => {
      const s = buildRootSpan({ ...base, spanId: genSpanId() });
      expect(s.name).toBe('invoke_agent pi');
      expect(s.kind).toBe(2); // SERVER
      const a = Object.fromEntries(s.attributes.map(x => [x.key, (x.value as any).stringValue ?? (x.value as any).intValue]));
      expect(a['gen_ai.operation.name']).toBe('invoke_agent');
      expect(a['session.id']).toBe('sess-1');
    });

    it('chat span: tokens (intValue) + llm.request/llm.response events', () => {
      const s = buildChatSpan({ ...base, spanId: genSpanId(), parentSpanId: 'root', model: 'claude-sonnet-4', inputTokens: 120, outputTokens: 30, userPrompt: 'why 500s?', completion: 'looking' });
      expect(s.name).toBe('chat claude-sonnet-4');
      const a = Object.fromEntries(s.attributes.map(x => [x.key, x.value]));
      expect(a['gen_ai.usage.input_tokens']).toEqual({ intValue: '120' });
      expect(s.events.find(e => e.name === 'llm.request')?.attributes[0].value).toEqual({ stringValue: 'why 500s?' });
      expect(s.events.find(e => e.name === 'llm.response')).toBeTruthy();
    });

    it('chat span omits llm.request when no userPrompt; redacts when asked', () => {
      const s = buildChatSpan({ ...base, spanId: genSpanId(), parentSpanId: 'r', model: 'm', completion: 'x' });
      expect(s.events.some(e => e.name === 'llm.request')).toBe(false);
      const r = buildChatSpan({ ...base, spanId: genSpanId(), parentSpanId: 'r', model: 'm', userPrompt: 'secret', redact: true });
      expect((r.events.find(e => e.name === 'llm.request')!.attributes[0].value as any).stringValue).toBe(REDACTED);
    });

    it('tool span: execute_tool + input/output attrs + ERROR status on failure', () => {
      const ok = buildToolSpan({ ...base, spanId: genSpanId(), parentSpanId: 'r', toolName: 'bash', input: { command: 'ls' }, output: 'out' });
      expect(ok.name).toBe('execute_tool bash');
      expect(ok.status.code).toBe(1);
      const a = Object.fromEntries(ok.attributes.map(x => [x.key, (x.value as any).stringValue]));
      expect(a['gen_ai.tool.input']).toBe('{"command":"ls"}');
      const bad = buildToolSpan({ ...base, spanId: genSpanId(), parentSpanId: 'r', toolName: 'edit', isError: true });
      expect(bad.status.code).toBe(2); // ERROR
    });

    it('buildOtlpPayload wraps spans with service.name resource', () => {
      const span = buildRootSpan({ ...base, spanId: genSpanId() });
      const payload = buildOtlpPayload(PI_SERVICE_NAME, [span]);
      const rs = payload.resourceSpans[0];
      expect((rs.resource.attributes[0].value as any).stringValue).toBe(PI_SERVICE_NAME);
      expect(rs.scopeSpans[0].spans).toHaveLength(1);
    });
  });
});
