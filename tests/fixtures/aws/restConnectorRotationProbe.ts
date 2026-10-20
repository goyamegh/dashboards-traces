/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process probe (run via tsx by
 * tests/integration/services/connectors/RESTConnector.sigv4Rotation.integration.test.ts).
 *
 * One long-lived process, like the Agent Health server:
 *   1. a local HTTP server plays the AWS side — it rebuilds the canonical
 *      request from the bytes it received and re-signs with the key it
 *      CURRENTLY trusts (key A, then B, then A again);
 *   2. the REAL `RESTConnector` with `auth.type = 'aws-sigv4'` + `awsProfile`
 *      (no static keys → credential chain → `$AWS_SHARED_CREDENTIALS_FILE`)
 *      sends request 1 → accepted with key A;
 *   3. the credentials file is rewritten to key B and the server trusts only
 *      B, answering a stale key the way AWS does (403 + "security token …
 *      expired"). Request 2, inside the TTL, is signed with A → rejected →
 *      the connector re-resolves, re-signs with B and is accepted (one replay,
 *      `BaseConnector.fetchSigned`);
 *   4. the file is rotated back to A and the server now rejects a stale key
 *      with a BARE `403 {}` (no credential signal — the body from the issue
 *      report). Request 3, inside the TTL, is signed with the cached B →
 *      403, NOT replayed (the bounded failure window); the clock is advanced
 *      past the TTL and request 4 is signed with A → accepted. No restart, no
 *      cache clearing.
 * Prints one JSON line with, per request, the access key id the connector
 * signed with, the server's verdict and the status the connector saw.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import type { ConnectorAuth } from '@/services/connectors/types';
import type { TestCase } from '@/types';
import { DEFAULT_CREDENTIAL_TTL_MS } from '@/lib/aws/refreshingCredentialProvider';
import { ROTATION_PROFILE, STATIC_KEY, writeStaticProfile, type StaticKeyName } from './rotationProfile';

const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE!;
const REGION = 'us-west-2';
const SERVICE = 'execute-api';
const AUTHZ_RE =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/;

// Deterministic clock for the provider's TTL, installed before any signing.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

/** Which key the "AWS side" currently trusts, and how it answers a stale one. */
let trusted: StaticKeyName = 'A';
let staleKeyVerdict = 'The security token included in the request is expired';
let baseUrl = '';

interface Observed {
  signedWith: string | null;
  verdict: string;
}
const observed: Observed[] = [];

async function verify(req: http.IncomingMessage, body: string): Promise<Observed> {
  const authorization = req.headers.authorization;
  if (!authorization) return { signedWith: null, verdict: 'MissingAuthenticationToken' };
  const m = authorization.match(AUTHZ_RE);
  if (!m) return { signedWith: null, verdict: 'MalformedAuthorization' };
  const [, accessKeyId, , region, service, signedHeaderList] = m;
  const creds = STATIC_KEY[trusted];
  // What AWS answers for a key that has been rotated out.
  if (accessKeyId !== creds.accessKeyId) return { signedWith: accessKeyId, verdict: staleKeyVerdict };
  if (req.headers['x-amz-security-token'] !== creds.sessionToken) return { signedWith: accessKeyId, verdict: 'InvalidToken' };

  const signedHeaders: Record<string, string> = {};
  for (const name of signedHeaderList.split(';')) {
    const value = req.headers[name];
    if (value === undefined) return { signedWith: accessKeyId, verdict: 'SignatureDoesNotMatch' };
    signedHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const amzDate = String(req.headers['x-amz-date']);
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  const url = new URL(req.url!, baseUrl);
  const verifier = new SignatureV4({ credentials: creds, region, service, sha256: Sha256 });
  const expected = await verifier.sign(
    {
      method: req.method!,
      protocol: url.protocol,
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      query: {},
      headers: signedHeaders,
      body,
    },
    { signingDate }
  );
  return { signedWith: accessKeyId, verdict: expected.headers.authorization === authorization ? 'ok' : 'SignatureDoesNotMatch' };
}

const testCase = {
  id: 'tc-sigv4-rotation',
  name: 'sigv4 rotation',
  initialPrompt: 'hello',
  expectedOutcomes: ['ok'],
  currentVersion: 1,
  labels: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as TestCase;

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const result = await verify(req, Buffer.concat(chunks).toString('utf8'));
      observed.push(result);
      if (result.verdict !== 'ok') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(result.verdict === 'bare' ? '{}' : JSON.stringify({ message: result.verdict }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'signature verified' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const auth: ConnectorAuth = { type: 'aws-sigv4', awsRegion: REGION, awsService: SERVICE, awsProfile: ROTATION_PROFILE };
  const connector = new RESTConnector();
  const invoke = async () => {
    try {
      const result = await connector.execute(`${baseUrl}/prod/invoke`, { testCase, modelId: 'm' }, auth);
      return { status: result.metadata?.status ?? 200, error: null };
    } catch (err) {
      return { status: 403, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const attemptsSince = (n: number) => observed.slice(n);
  const request1 = { ...(await invoke()), attempts: attemptsSince(0) };

  // Rotation A → B: the credential helper rewrites the profile; AWS stops
  // trusting A and says so.
  writeStaticProfile(credentialsFile, 'B');
  trusted = 'B';
  offsetMs = DEFAULT_CREDENTIAL_TTL_MS / 2;
  const seen2 = observed.length;
  const request2InTtlWithSignal = { ...(await invoke()), attempts: attemptsSince(seen2) };

  // Rotation B → A, but this time the front door rejects a stale key with a
  // bare `403 {}` — no credential signal, nothing to retry on.
  writeStaticProfile(credentialsFile, 'A');
  trusted = 'A';
  staleKeyVerdict = 'bare';
  offsetMs = DEFAULT_CREDENTIAL_TTL_MS / 2 + 5_000; // still inside the TTL that restarted at request 2's refresh
  const seen3 = observed.length;
  const request3InTtlBare = { ...(await invoke()), attempts: attemptsSince(seen3) };

  offsetMs = DEFAULT_CREDENTIAL_TTL_MS / 2 + 5_000 + DEFAULT_CREDENTIAL_TTL_MS; // past the TTL
  const seen4 = observed.length;
  const request4AfterTtl = { ...(await invoke()), attempts: attemptsSince(seen4) };

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write(`${JSON.stringify({ request1, request2InTtlWithSignal, request3InTtlBare, request4AfterTtl })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
