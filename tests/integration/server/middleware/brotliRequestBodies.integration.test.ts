/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CVE-2026-111497 (Node.js brotli decoder OOB write → RCE) defence-in-depth,
 * through the REAL server (whatever AH_PORT points at — `createApp()` wiring,
 * real body-parser, real routes):
 *
 *   - a brotli-encoded (`Content-Encoding: br`) JSON body on ANY JSON route is
 *     answered 415 `{ code: 'UNSUPPORTED_CONTENT_ENCODING' }` and is never
 *     parsed — proven by the storage create route NOT creating anything;
 *   - the same body gzip-encoded or uncompressed is handled exactly as before
 *     (201 created / 400 validation / 200 OTLP ack).
 *
 * Red on origin/main: the brotli case there returns 201 (body-parser pipes the
 * body through `zlib.createBrotliDecompress()` and the test case IS created).
 *
 * Run: AH_PORT=<port> npm run test:integration -- brotliRequestBodies
 */

import zlib from 'zlib';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const TEST_TIMEOUT = 30000;
const tracker = createTestDataTracker();

let backendAvailable = false;

beforeAll(async () => {
  try {
    backendAvailable = (await fetch(`${BASE_URL}/health`)).ok;
  } catch {
    backendAvailable = false;
  }
  if (!backendAvailable) console.warn('Backend not available at', BASE_URL, '- skipping');
});

afterAll(async () => {
  if (backendAvailable) await tracker.cleanup();
});

async function post(path: string, body: Buffer, encoding?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (encoding) headers['Content-Encoding'] = encoding;
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* keep {} */ }
  return { status: res.status, json, contentType: res.headers.get('content-type') ?? '' };
}

function testCaseBody(name: string): Buffer {
  return Buffer.from(JSON.stringify({
    name,
    category: 'RCA',
    difficulty: 'Easy',
    initialPrompt: 'brotli guard probe',
    expectedOutcomes: ['probe'],
  }));
}

function trackCreated(json: any): string {
  const id = json?.testCase?.id ?? json?.id;
  expect(typeof id).toBe('string');
  tracker.testCase(id);
  return id;
}

describe('Brotli-encoded request bodies are rejected before body parsing (CVE-2026-111497)', () => {
  describe('POST /api/storage/test-cases', () => {
    it('br → 415 UNSUPPORTED_CONTENT_ENCODING and nothing is created', async () => {
      if (!backendAvailable) return;
      const name = uniqueTestName('brotli-guard');
      const res = await post('/api/storage/test-cases', zlib.brotliCompressSync(testCaseBody(name)), 'br');

      expect(res.status).toBe(415);
      expect(res.contentType).toMatch(/application\/json/);
      expect(res.json.code).toBe('UNSUPPORTED_CONTENT_ENCODING');
      expect(res.json.error).toMatch(/Unsupported Content-Encoding: br/);
      // Guard against a false negative: had the body been decoded, a test
      // case would exist — on origin/main this branch tracks (and deletes) it.
      if (res.json?.testCase?.id || res.json?.id) trackCreated(res.json);
      expect(res.json?.testCase?.id ?? res.json?.id).toBeUndefined();
    }, TEST_TIMEOUT);

    it('gzip → decoded and created as before (201)', async () => {
      if (!backendAvailable) return;
      const name = uniqueTestName('gzip-ok');
      const res = await post('/api/storage/test-cases', zlib.gzipSync(testCaseBody(name)), 'gzip');
      expect(res.status).toBe(201);
      trackCreated(res.json);
      expect(res.json?.testCase?.name ?? res.json?.name).toBe(name);
    }, TEST_TIMEOUT);

    it('uncompressed → created as before (201)', async () => {
      if (!backendAvailable) return;
      const name = uniqueTestName('identity-ok');
      const res = await post('/api/storage/test-cases', testCaseBody(name));
      expect(res.status).toBe(201);
      trackCreated(res.json);
      expect(res.json?.testCase?.name ?? res.json?.name).toBe(name);
    }, TEST_TIMEOUT);
  });

  describe('POST /api/evaluate', () => {
    // Fails the route's own validation ("Either testCaseId or testCase is
    // required") so no evaluation is ever started.
    const body = Buffer.from(JSON.stringify({ agentKey: 'nope', modelId: 'nope' }));

    it('br → 415 before the route sees the body', async () => {
      if (!backendAvailable) return;
      const res = await post('/api/evaluate', zlib.brotliCompressSync(body), 'br');
      expect(res.status).toBe(415);
      expect(res.json.code).toBe('UNSUPPORTED_CONTENT_ENCODING');
    }, TEST_TIMEOUT);

    it('gzip → decoded, route validation answers 400 as before', async () => {
      if (!backendAvailable) return;
      const res = await post('/api/evaluate', zlib.gzipSync(body), 'gzip');
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/testCaseId or testCase/);
    }, TEST_TIMEOUT);

    it('uncompressed → route validation answers 400 as before', async () => {
      if (!backendAvailable) return;
      const res = await post('/api/evaluate', body);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/testCaseId or testCase/);
    }, TEST_TIMEOUT);
  });

  describe('POST /v1/traces (embedded OTLP/JSON receiver)', () => {
    // Empty resourceSpans: valid OTLP, ingests nothing.
    const body = Buffer.from(JSON.stringify({ resourceSpans: [] }));

    it('br → 415', async () => {
      if (!backendAvailable) return;
      const res = await post('/v1/traces', zlib.brotliCompressSync(body), 'br');
      expect(res.status).toBe(415);
      expect(res.json.code).toBe('UNSUPPORTED_CONTENT_ENCODING');
    }, TEST_TIMEOUT);

    it('gzip (what OTLP/HTTP exporters actually send) → 200 ack as before', async () => {
      if (!backendAvailable) return;
      const res = await post('/v1/traces', zlib.gzipSync(body), 'gzip');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ partialSuccess: {} });
    }, TEST_TIMEOUT);
  });
});
