/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CVE-2026-111497 defence-in-depth for the sample agent's AG-UI HTTP server:
 * `HTTPServer.setupMiddleware()` must mount `rejectBrotliRequestBodies`
 * BEFORE `express.json()`, so a `Content-Encoding: br` POST to `/run-agent`
 * is answered 415 without the body ever reaching the brotli decoder, while
 * gzip and uncompressed bodies still reach the route's own validation.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import zlib from 'zlib';
import { HTTPServer } from '@/observio-sample-agent/src/server/http_server';
import { UNSUPPORTED_CONTENT_ENCODING_CODE } from '@/observio-sample-agent/src/server/reject_brotli_bodies';

const noopLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } as any;
const stubAdapter = { getTools: jest.fn(async () => []) } as any;

// Deliberately invalid RunAgentInput (no messages) so the route's own
// validation answers deterministically (400) without invoking an agent.
const BODY = Buffer.from(JSON.stringify({ threadId: 't-1', runId: 'r-1' }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const httpServer = new HTTPServer({ port: 0 } as any, stubAdapter, noopLogger);
  httpServer.setupMiddleware();
  httpServer.setupRoutes();
  const app = (httpServer as any).app;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postRunAgent(body: Buffer, encoding?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (encoding) headers['Content-Encoding'] = encoding;
  const res = await fetch(`${baseUrl}/run-agent`, { method: 'POST', headers, body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('observio sample agent HTTP server — brotli request bodies (CVE-2026-111497)', () => {
  it('rejects a brotli-encoded body with 415 + UNSUPPORTED_CONTENT_ENCODING', async () => {
    const res = await postRunAgent(zlib.brotliCompressSync(BODY), 'br');
    expect(res.status).toBe(415);
    expect(res.json.code).toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
    expect(res.json.error).toMatch(/Unsupported Content-Encoding: br/);
  });

  it('still decodes a gzip-encoded body and hands it to the route (400 from input validation)', async () => {
    const res = await postRunAgent(zlib.gzipSync(BODY), 'gzip');
    expect(res.status).toBe(400);
    expect(res.json.code).not.toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
  });

  it('still handles an uncompressed body normally (400 from input validation)', async () => {
    const res = await postRunAgent(BODY);
    expect(res.status).toBe(400);
    expect(res.json.code).not.toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
  });

  it('leaves body-less routes alone', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});
