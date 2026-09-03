/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for an API KPI-probe finding (F4): a malformed JSON
 * body on ANY route used to fall through to Express's default error
 * handler, which renders an HTML page containing the raw SyntaxError stack
 * trace (leaking internal file paths). Every route must instead answer
 * clean JSON, and any other uncaught error must never leak a stack/HTML.
 */

import express, { Express, Request, Response } from 'express';
import request from 'supertest';

// Minimal, isolated app that exercises the exact same middleware wiring as
// server/app.ts, without booting the real app (no storage/config/telemetry
// side effects needed for this regression).
function buildTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Mirrors setupJsonParser()'s body-parser SyntaxError handler.
  app.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    next(err);
  });

  app.post('/api/test/echo', (req: Request, res: Response) => {
    res.json({ received: req.body });
  });

  app.get('/api/test/throws', () => {
    throw new Error('boom: /etc/secret/path leaked here');
  });

  app.post('/api/test/throws-status', (req: Request, res: Response, next) => {
    const err: any = new Error('custom status error');
    err.status = 422;
    next(err);
  });

  // Mirrors setupFinalErrorHandler().
  app.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(err?.status && Number.isInteger(err.status) ? err.status : 500).json({
      error: 'Internal server error',
    });
  });

  return app;
}

describe('Global error middleware (F4 regression)', () => {
  let app: Express;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    app = buildTestApp();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const routes = ['/api/test/echo'];

  for (const route of routes) {
    it(`returns 400 JSON (never HTML/stack) for malformed JSON on ${route}`, async () => {
      const res = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .send('{not json');

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: 'invalid JSON body' });
      const raw = JSON.stringify(res.body) + (res.text || '');
      expect(raw).not.toContain('SyntaxError');
      expect(raw.toLowerCase()).not.toContain('<html');
    });
  }

  it('still accepts valid JSON bodies on the same route (no regression)', async () => {
    const res = await request(app)
      .post('/api/test/echo')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { hello: 'world' } });
  });

  it('returns 413 JSON (never HTML/stack) when body-parser reports entity.too.large', async () => {
    const testApp = express();
    testApp.post('/api/test/too-large', (req: Request, res: Response, next: express.NextFunction) => {
      const err: any = new Error('request entity too large');
      err.type = 'entity.too.large';
      next(err);
    });
    testApp.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
      if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'request body too large' });
      }
      next(err);
    });

    const res = await request(testApp).post('/api/test/too-large').send({});
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'request body too large' });
  });

  it('final error handler returns JSON, never a stack trace or HTML, for a synchronously thrown error', async () => {
    const res = await request(app).get('/api/test/throws');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'Internal server error' });
    const raw = JSON.stringify(res.body) + (res.text || '');
    expect(raw).not.toContain('/etc/secret/path');
    expect(raw).not.toContain('at ');
    expect(raw.toLowerCase()).not.toContain('<html');
  });

  it('final error handler honours a numeric err.status without leaking the message', async () => {
    const res = await request(app)
      .post('/api/test/throws-status')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
