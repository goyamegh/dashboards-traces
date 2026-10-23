/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route guards of the built-in assistant: `assistant.enabled: false` → 404,
 * per-client rate limit → 429 with Retry-After, concurrency cap → 429 before
 * the stream opens, status endpoint shape. The service is mocked here; the
 * SDK wiring has its own test.
 */

const mockSettings = jest.fn();
const mockInFlight = jest.fn(() => 0);
const mockStreamAsk = jest.fn();
const mockPrepare = jest.fn();

jest.mock('@/server/services/ask/askService', () => ({
  resolveAskSettings: (...a: any[]) => mockSettings(...a),
  askInFlight: () => mockInFlight(),
  streamAsk: (...a: any[]) => mockStreamAsk(...a),
  prepareAsk: (...a: any[]) => mockPrepare(...a),
  getAskSessionStore: async () => ({ dir: '/tmp/ask', list: () => [], get: () => null }),
  AskBusyError: class AskBusyError extends Error { constructor(max: number) { super(`busy ${max}`); } },
  ASK_AGENT: { key: 'agent-health-assistant', name: 'Agent Health assistant' },
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import express, { Application } from 'express';
const request = require('supertest');
import askRouter, { checkRateLimit, resetRateLimit, ASK_RATE_LIMIT } from '@/server/routes/ask';

const enabled = { enabled: true, model: undefined, sessionsDir: '/tmp/ask', maxConcurrent: 4 };

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(askRouter);
  return app;
}

describe('ask routes — guards', () => {
  let app: Application;
  beforeEach(() => {
    jest.clearAllMocks();
    resetRateLimit();
    mockSettings.mockReturnValue(enabled);
    mockInFlight.mockReturnValue(0);
    mockStreamAsk.mockImplementation((_req: any, cb: any) => { setTimeout(() => cb.onDone({ answer: 'ok', durationMs: 1, toolCalls: [] }), 0); return { abort: jest.fn() }; });
    mockPrepare.mockResolvedValue({ sessionId: 'ask-1', refs: {}, loaded: [], model: 'm' });
    app = makeApp();
  });

  it('GET /api/ask/status reports the effective settings and that history is local', async () => {
    mockSettings.mockReturnValue({ ...enabled, model: 'amazon-bedrock/x' });
    mockInFlight.mockReturnValue(2);
    const res = await request(app).get('/api/ask/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true, agent: { key: 'agent-health-assistant', name: 'Agent Health assistant' },
      model: 'amazon-bedrock/x', sessionsDir: '/tmp/ask', maxConcurrent: 4, inFlight: 2, local: true,
    });
  });

  it('assistant.enabled: false → every route but /status answers 404 and never touches the service', async () => {
    mockSettings.mockReturnValue({ ...enabled, enabled: false });
    expect((await request(app).get('/api/ask/status')).body.enabled).toBe(false);
    for (const [method, path] of [['post', '/api/ask'], ['post', '/api/ask/prepare'], ['get', '/api/ask/sessions'], ['get', '/api/ask/sessions/x']] as const) {
      const res = await (request(app) as any)[method](path).send({ question: 'q', pageContext: { route: '/' } });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/assistant is disabled/);
    }
    expect(mockStreamAsk).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('streams when enabled, and 429s with Retry-After once the concurrency cap is reached', async () => {
    const ok = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/event-stream/);
    expect(ok.text).toContain('"type":"done"');

    mockInFlight.mockReturnValue(4);
    const busy = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('15');
    expect(busy.body.error).toMatch(/busy 4/);
    expect(mockStreamAsk).toHaveBeenCalledTimes(1);
  });

  it('rate-limits asks and prepares per client in separate buckets', async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.asks; i++) {
      expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } })).status).toBe(200);
    }
    const limited = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.error).toMatch(/Too many assistant requests/);
    // prepares are a separate, larger bucket
    expect((await request(app).post('/api/ask/prepare').send({ pageContext: { route: '/' } })).status).toBe(200);
    expect(mockStreamAsk).toHaveBeenCalledTimes(ASK_RATE_LIMIT.asks);
  });

  it('checkRateLimit: fixed window per client; the window resets after windowMs', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ASK_RATE_LIMIT.prepares; i++) expect(checkRateLimit('a', 'prepares', t0).ok).toBe(true);
    const denied = checkRateLimit('a', 'prepares', t0 + 10_000);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBe(50);
    expect(checkRateLimit('b', 'prepares', t0).ok).toBe(true); // other client unaffected
    expect(checkRateLimit('a', 'asks', t0).ok).toBe(true); // other bucket unaffected
    expect(checkRateLimit('a', 'prepares', t0 + ASK_RATE_LIMIT.windowMs).ok).toBe(true);
  });

  it('validates bodies before anything else', async () => {
    expect((await request(app).post('/api/ask').send({ pageContext: { route: '/' } })).body.error).toMatch(/question is required/);
    expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: {} })).status).toBe(400);
    expect((await request(app).post('/api/ask/prepare').send({})).status).toBe(400);
    expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' }, selections: new Array(21).fill({ text: 'x' }) })).body.error).toMatch(/max 20/);
  });
});
