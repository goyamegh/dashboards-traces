/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the "rebuild-without-restart" SPA fallback bug.
 *
 * Boots the REAL compiled server (`node server/dist/index.js`, same as
 * `.github/workflows/ci.yml`'s "Start backend server" step) against a
 * dedicated test port, then simulates an in-place `npm run build` by
 * rewriting `dist/index.html` and adding a new `dist/assets/*` file WHILE
 * THE SERVER IS STILL RUNNING (no restart). Asserts the very next request
 * serves the NEW index.html (referencing the new asset name), proving the
 * SPA fallback middleware re-reads the file instead of serving a boot-time
 * snapshot.
 *
 * Requires `dist/` to exist (i.e. `npm run build:all` has run) — skips with
 * a warning otherwise, since this test verifies production static-serving
 * behavior that doesn't exist in an unbuilt tree.
 *
 * Never touches ports 4000/4001 (the live dev/prod ports) — uses its own
 * ephemeral port.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const INDEX_PATH = path.join(DIST_DIR, 'index.html');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'dist', 'index.js');

const TEST_TIMEOUT = 60_000;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        return reject(new Error('could not allocate a free port'));
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const distBuilt = fs.existsSync(INDEX_PATH) && fs.existsSync(SERVER_ENTRY);

(distBuilt ? describe : describe.skip)(
  'SPA fallback — serves fresh index.html after an in-place rebuild (no restart)',
  () => {
    let port: number;
    let child: ChildProcess | null = null;
    let originalIndexHtml: string;
    let createdAssetPath: string | null = null;
    let removedAssetBackup: { path: string; content: Buffer } | null = null;

    beforeAll(async () => {
      if (!distBuilt) return;
      originalIndexHtml = fs.readFileSync(INDEX_PATH, 'utf-8');

      port = await getFreePort();
      // Never 4000/4001 — getFreePort() picks an OS-assigned ephemeral port,
      // which the kernel never hands out for well-known ports already bound
      // by the live dev/prod servers.
      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AH_PORT: String(port),
          HOST: '127.0.0.1',
          BENCHMARK_RUN_RECOVERY_DISABLED: '1',
          EVALUATION_RUN_RECOVERY_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const healthy = await waitForHealth(port, TEST_TIMEOUT - 5000);
      if (!healthy) {
        throw new Error(`test server on port ${port} did not become healthy in time`);
      }
    }, TEST_TIMEOUT);

    afterAll(async () => {
      if (child) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 200));
      }
      // Restore dist/ exactly as we found it so re-running the suite (or a
      // subsequent `npm run test:integration`) sees the real build output,
      // not test fixtures.
      if (distBuilt) {
        fs.writeFileSync(INDEX_PATH, originalIndexHtml, 'utf-8');
      }
      if (createdAssetPath && fs.existsSync(createdAssetPath)) {
        fs.rmSync(createdAssetPath);
      }
      if (removedAssetBackup) {
        fs.writeFileSync(removedAssetBackup.path, removedAssetBackup.content);
      }
    }, TEST_TIMEOUT);

    it('serves the NEW index.html (new asset hash) on the next request, without restarting', async () => {
      // 1. Confirm the server currently serves the real, pre-existing index.html.
      const before = await fetch(`http://127.0.0.1:${port}/`);
      expect(before.status).toBe(200);
      const beforeBody = await before.text();
      expect(beforeBody).toBe(originalIndexHtml);

      // 2. Simulate an in-place rebuild in the SAME running process:
      //    a brand-new asset file appears, and index.html is rewritten to
      //    reference it — exactly what `vite build` does on every run.
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
      const newAssetName = `regression-test-${Date.now()}.js`;
      createdAssetPath = path.join(ASSETS_DIR, newAssetName);
      fs.writeFileSync(createdAssetPath, '// new build output\n', 'utf-8');

      const newIndexHtml = `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/assets/${newAssetName}"></script></body></html>`;
      // Ensure a strictly-advanced mtime even on coarse-resolution filesystems.
      fs.writeFileSync(INDEX_PATH, newIndexHtml, 'utf-8');
      const stat = fs.statSync(INDEX_PATH);
      const bumped = new Date(stat.mtimeMs + 2000);
      fs.utimesSync(INDEX_PATH, bumped, bumped);

      // 3. Next request, NO server restart: must reflect the new build.
      const after = await fetch(`http://127.0.0.1:${port}/`);
      expect(after.status).toBe(200);
      const afterBody = await after.text();
      expect(afterBody).toBe(newIndexHtml);
      expect(afterBody).toContain(newAssetName);
      expect(afterBody).not.toBe(beforeBody);

      // 4. The new asset itself must be reachable too (express.static reads
      //    fresh per-request already — this pins that it stays that way).
      const assetRes = await fetch(`http://127.0.0.1:${port}/assets/${newAssetName}`);
      expect(assetRes.status).toBe(200);
    }, TEST_TIMEOUT);

    it('a client-side route also reflects the new index.html immediately', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/evaluations/benchmarks/some-run`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('regression-test-');
    }, TEST_TIMEOUT);
  },
);
