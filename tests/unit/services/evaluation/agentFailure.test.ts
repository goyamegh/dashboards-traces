/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * services/evaluation/agentFailure.ts — unwrapping + classifying agent-step
 * errors. undici's opaque `TypeError: fetch failed` must never be the recorded
 * cause; the `HeadersTimeoutError` on `error.cause` must be surfaced and
 * classified as a timeout.
 */

import { describeAgentError, classifyAgentError, unwrapErrorMessage } from '@/services/evaluation/agentFailure';

/** Exactly what Node 20/22/24's fetch throws after the default 300 s headersTimeout. */
function undiciHeadersTimeout(): Error {
  const cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('agentFailure — unwrapErrorMessage', () => {
  it('unwraps undici "fetch failed" to the HeadersTimeoutError cause (never the bare wrapper)', () => {
    const msg = unwrapErrorMessage(undiciHeadersTimeout());
    expect(msg).toMatch(/HeadersTimeoutError/);
    expect(msg).toMatch(/UND_ERR_HEADERS_TIMEOUT/);
    expect(msg).not.toMatch(/fetch failed/);
  });

  it('unwraps ECONNREFUSED from the cause chain', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(unwrapErrorMessage(err)).toMatch(/ECONNREFUSED 127\.0\.0\.1:8000/);
  });

  it('returns the message as-is for a plain informative error, appending only a distinct deeper code', () => {
    expect(unwrapErrorMessage(new Error('REST request failed: 503 - upstream down'))).toBe('REST request failed: 503 - upstream down');
    const outer = Object.assign(new Error('NetworkError: Connection refused'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(unwrapErrorMessage(outer)).toBe('NetworkError: Connection refused [ECONNREFUSED]');
  });

  it('handles strings, nulls and cyclic causes', () => {
    expect(unwrapErrorMessage('boom')).toBe('boom');
    expect(unwrapErrorMessage(null)).toBe('Unknown error');
    const a: any = new Error('a'); const b: any = new Error('b'); a.cause = b; b.cause = a;
    expect(() => unwrapErrorMessage(a)).not.toThrow();
  });
});

describe('agentFailure — classifyAgentError', () => {
  it('classifies undici headers timeout as timeout', () => {
    expect(classifyAgentError(undiciHeadersTimeout()).kind).toBe('timeout');
  });
  it('classifies AbortError / "timed out" text as timeout', () => {
    expect(classifyAgentError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })).kind).toBe('timeout');
    expect(classifyAgentError(new Error('Subprocess timed out after 600000ms')).kind).toBe('timeout');
  });
  it('classifies ECONNREFUSED / ENOTFOUND / socket hang up as connection', () => {
    expect(classifyAgentError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).kind).toBe('connection');
    expect(classifyAgentError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND agent.internal'), { code: 'ENOTFOUND' }) })).kind).toBe('connection');
    expect(classifyAgentError(new Error('socket hang up')).kind).toBe('connection');
  });
  it('classifies the REST connector non-2xx wording as http_<status>', () => {
    const r = classifyAgentError(new Error('REST request failed: 503 - Service Unavailable'));
    expect(r.kind).toBe('http_503');
    expect(r.httpStatus).toBe(503);
  });
  it('classifies an error carrying httpStatus as http_<status>', () => {
    expect(classifyAgentError(Object.assign(new Error('slow down'), { httpStatus: 429 })).kind).toBe('http_429');
  });
  it('falls back to unknown', () => {
    expect(classifyAgentError(new Error('something odd')).kind).toBe('unknown');
  });
});

describe('agentFailure — describeAgentError', () => {
  it('produces a populated AgentErrorInfo (kind + unwrapped cause + endpoint + elapsed)', () => {
    const info = describeAgentError(undiciHeadersTimeout(), { endpoint: 'http://localhost:8000/ask', elapsedMs: 300_728.4 });
    expect(info).toEqual({
      kind: 'timeout',
      message: expect.stringMatching(/^HeadersTimeoutError: Headers Timeout Error \(UND_ERR_HEADERS_TIMEOUT\) \(http:\/\/localhost:8000\/ask\)$/),
      endpoint: 'http://localhost:8000/ask',
      elapsedMs: 300_728,
    });
  });

  it('does not duplicate an endpoint already in the message; carries httpStatus for non-2xx', () => {
    const info = describeAgentError(new Error('REST request failed: 500 - boom (http://a/b)'), { endpoint: 'http://a/b' });
    expect(info.message.match(/http:\/\/a\/b/g)?.length).toBe(1);
    expect(info.kind).toBe('http_500');
    expect(info.httpStatus).toBe(500);
  });
});
