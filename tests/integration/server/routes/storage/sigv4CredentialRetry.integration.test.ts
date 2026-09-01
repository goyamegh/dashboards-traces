/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the "credential re-resolve on 403" fix
 * (server/services/opensearchClientFactory.ts resolveSigv4Credentials()).
 *
 * Reproduces the 2026-08-30 incident end-to-end against a REAL, separately
 * spawned agent-health server process (like portIsolation.integration.test.ts,
 * so the real @smithy/shared-ini-file-loader file cache and the real
 * configService.ts run unmocked — jest's moduleNameMapper stubs configService
 * for in-process tests, which would hide this exact bug):
 *
 *   1. Boot the server pointed (via OPENSEARCH_STORAGE_* env vars) at a fake
 *      local SigV4 "OpenSearch" that returns HTTP 403, with a real
 *      AWS_SHARED_CREDENTIALS_FILE containing a profile with an "OLDKEY".
 *   2. POST /api/storage/config/retry -> expect failure (403), and confirm the
 *      signed request that reached the fake cluster actually used OLDKEY.
 *   3. Simulate `ada credentials update` in place: rewrite the SAME
 *      credentials file with "NEWKEY", and flip the fake cluster to accept.
 *   4. POST /api/storage/config/retry AGAIN on the SAME running process (no
 *      restart) -> expect success, and confirm the signed request now used
 *      NEWKEY — proving the server re-read the rotated file from disk instead
 *      of serving the AWS SDK's process-lifetime cached file content.
 *
 * Without the `ignoreCache: true` fix, step 4's request is signed with the
 * stale OLDKEY (the SDK's `@smithy/shared-ini-file-loader` module-level
 * `filePromises` cache from step 1's read), so the retry logically depends on
 * the ROTATED file's OLDER content and this test's final assertion fails —
 * this is the exact "retry still returns 403 after ada already fixed the
 * creds" bug.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import http, { type Server as HttpServer } from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { existsSync } from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const TEST_TIMEOUT = 60000;
const AH_PORT = 4361; // unique per-worker port range per repo convention (43xx)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Minimal fake SigV4-signed "OpenSearch" — records the Credential access-key
 *  it was signed with, and answers 403 or 200 depending on `misbehaving`. */
function startFakeOpenSearch(): {
  server: HttpServer;
  port: Promise<number>;
  state: { misbehaving: boolean; lastAccessKeyId: string | null; requestCount: number };
} {
  const state = { misbehaving: true, lastAccessKeyId: null as string | null, requestCount: 0 };
  const server = http.createServer((req, res) => {
    state.requestCount++;
    const authHeader = req.headers['authorization'] || '';
    const match = /Credential=([^/]+)\//.exec(Array.isArray(authHeader) ? authHeader[0] : authHeader);
    state.lastAccessKeyId = match ? match[1] : null;

    if (state.misbehaving) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Message: 'User is not authorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cluster_name: 'fake-cluster', status: 'green', number_of_nodes: 1 }));
  });

  const portPromise = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

  return { server, port: portPromise, state };
}

function writeCredentialsFile(filePath: string, accessKeyId: string): void {
  fs.writeFileSync(
    filePath,
    `[default]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = secret-${accessKeyId}\naws_session_token = token-${accessKeyId}\n`,
    'utf8'
  );
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/health on ${port} did not respond within ${timeoutMs}ms`);
}

describe('SigV4 credential re-resolve on 403 — recovers via /api/storage/config/retry without a restart', () => {
  let child: ChildProcess | undefined;
  let fake: ReturnType<typeof startFakeOpenSearch> | undefined;
  let credsFile: string | undefined;
  let configFile: string | undefined;
  let fakePort: number;

  beforeAll(async () => {
    if (!existsSync(SERVER_APP)) {
      execSync('npm run build:server', { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    fake = startFakeOpenSearch();
    fakePort = await fake.port;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sigv4-retry-'));
    credsFile = path.join(tmpDir, 'credentials');
    configFile = path.join(tmpDir, 'config');
    writeCredentialsFile(credsFile, 'OLDKEY');
    fs.writeFileSync(configFile, '[default]\n', 'utf8');

    child = spawn(
      'node',
      ['--import', 'tsx', CLI_ENTRY, 'serve', '-p', String(AH_PORT), '--no-browser', '--headless'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AH_PORT: String(AH_PORT),
          BENCHMARK_RUN_RECOVERY_DISABLED: '1',
          EVALUATION_RUN_RECOVERY_DISABLED: '1',
          AH_SUPPRESS_EXPERIMENTAL: '1',
          // Point storage at the fake cluster via env-based resolution
          // (no agent-health.config.ts / state.json involved).
          OPENSEARCH_STORAGE_ENDPOINT: `http://127.0.0.1:${fakePort}`,
          OPENSEARCH_STORAGE_AUTH_TYPE: 'sigv4',
          OPENSEARCH_STORAGE_AWS_PROFILE: 'default',
          OPENSEARCH_STORAGE_AWS_REGION: 'us-east-1',
          // Force the AWS SDK through the ini-file provider deterministically,
          // pointed at OUR temp credentials file (not the real ~/.aws/*).
          AWS_SHARED_CREDENTIALS_FILE: credsFile,
          AWS_CONFIG_FILE: configFile,
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_ACCESS_KEY_ID: '',
          AWS_SECRET_ACCESS_KEY: '',
          AWS_SESSION_TOKEN: '',
          AWS_PROFILE: '',
        },
        detached: true,
        stdio: 'ignore',
      }
    );

    await waitForHealth(AH_PORT, TEST_TIMEOUT);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* noop */ }
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (fake) await new Promise<void>((r) => fake!.server.close(() => r()));
    if (credsFile) fs.rmSync(path.dirname(credsFile), { recursive: true, force: true });
  });

  it(
    'retry fails with 403 while the fake cluster misbehaves, signed with the OLD on-disk key',
    async () => {
      const res = await fetch(`http://127.0.0.1:${AH_PORT}/api/storage/config/retry`, { method: 'POST' });
      const body = await res.json();

      expect(body.success).toBe(false);
      expect(body.state.backend).toBe('error');
      expect(body.state.error).toContain('403');
      expect(fake!.state.lastAccessKeyId).toBe('OLDKEY');
    },
    TEST_TIMEOUT
  );

  it(
    'after rotating the credentials file in place (simulating `ada credentials update`) AND the cluster starting to accept, ' +
      'retry on the SAME running process recovers and signs with the NEW key — no restart',
    async () => {
      // Simulate `ada credentials update` rewriting the file the running
      // process already read once.
      writeCredentialsFile(credsFile!, 'NEWKEY');
      fake!.state.misbehaving = false;

      const res = await fetch(`http://127.0.0.1:${AH_PORT}/api/storage/config/retry`, { method: 'POST' });
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.state.backend).toBe('opensearch');
      // The decisive assertion: the request that reached the cluster was
      // signed with the ROTATED key, proving the server re-read
      // ~/.aws/credentials from disk rather than reusing the process-lifetime
      // cached file content from the very first resolution.
      expect(fake!.state.lastAccessKeyId).toBe('NEWKEY');
    },
    TEST_TIMEOUT
  );
});
