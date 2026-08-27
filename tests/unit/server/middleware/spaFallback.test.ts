/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the SPA fallback middleware factory.
 *
 * Regression coverage for the production white-screen bug:
 *
 *   "Failed to load module script: Expected a JavaScript-or-Wasm module
 *    script but the server responded with a MIME type of \"text/html\"."
 *
 * Cause #1 (fixed earlier): a stale cached `index.html` references
 * `/assets/index-OLDHASH.js`, the asset no longer exists, the SPA fallback
 * used to return `index.html` (text/html) for ANY non-/api path, and strict
 * MIME enforcement in browsers refuses to execute it as a module — leaving
 * the user with a blank page after every deploy.
 *
 * Cause #2 (this file's new coverage): even with the asset-extension 404s
 * above, `makeSpaFallbackMiddleware` used to be handed a pre-read HTML
 * *string* once at process boot. Rebuilding `dist/` in the same long-lived
 * process (e.g. re-running `npm run build` in a live worktree) rehashes
 * `dist/assets/*`, but the cached string still references the old,
 * now-deleted hashes — so index.html itself goes stale and every SPA route
 * serves broken asset references until a restart. The fix: the middleware
 * now takes a file *path* and re-reads it whenever its mtime changes,
 * falling back to the last-good cached copy if a read fails mid-rebuild.
 *
 * The middleware factory is in `server/middleware/spaFallback.ts` so this
 * test file can import it without dragging `server/middleware/index.ts`'s
 * top-level `import.meta.url` into ts-jest's CJS transform.
 */

import express, { Express } from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeSpaFallbackMiddleware, ASSET_EXT_RE } from '@/server/middleware/spaFallback';

const FAKE_INDEX_HTML =
  '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>';

interface ProbeResult {
  status: number;
  contentType: string;
  body: string;
}

function probe(app: Express, urlPath: string, method = 'GET'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('no address'));
      }
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, path: urlPath, method },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode || 0,
              contentType: String(res.headers['content-type'] || ''),
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// Bump mtime forward by `ms` (and beyond) to guarantee a detectable change
// even on filesystems with coarse mtime resolution.
function touchWithContent(filePath: string, content: string, mtimeOffsetMs: number): void {
  fs.writeFileSync(filePath, content, 'utf-8');
  const stat = fs.statSync(filePath);
  const newMtime = new Date(stat.mtimeMs + mtimeOffsetMs);
  fs.utimesSync(filePath, newMtime, newMtime);
}

function buildApp(indexPath: string): Express {
  const app = express();
  // Real API routes registered ahead of the fallback to verify the fallback
  // doesn't shadow them.
  app.get('/api/storage/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(makeSpaFallbackMiddleware(indexPath));
  return app;
}

describe('makeSpaFallbackMiddleware', () => {
  let tmpDir: string;
  let indexPath: string;
  let app: Express;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-fallback-test-'));
    indexPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(indexPath, FAKE_INDEX_HTML, 'utf-8');
    app = buildApp(indexPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves index.html (text/html) for the root path', async () => {
    const r = await probe(app, '/');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toContain('<div id="root">');
  });

  it('serves index.html for client-side routes without extensions', async () => {
    const r = await probe(app, '/evaluations/benchmarks/foo/runs/bar/inspect');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toContain('<div id="root">');
  });

  it('returns 404 (NOT html) for missing /assets/ JS bundles — the regression', async () => {
    // The exact bug shape: stale cached index.html requests an old hash.
    // Pre-fix this returned 200 with text/html, triggering strict-MIME
    // refusal in the browser and a blank page.
    const r = await probe(app, '/assets/index-OLDHASH.js');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
    expect(r.body).not.toContain('<html');
  });

  it('returns 404 (NOT html) for missing /assets/ CSS bundles', async () => {
    const r = await probe(app, '/assets/index-OLDHASH.css');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it('returns 404 (NOT html) for missing /assets/ source map', async () => {
    const r = await probe(app, '/assets/index-OLDHASH.js.map');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it('returns 404 (NOT html) for missing /static/ assets', async () => {
    const r = await probe(app, '/static/foo.js');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it.each([
    '/missing.js',
    '/missing.mjs',
    '/missing.css',
    '/missing.map',
    '/missing.png',
    '/missing.svg',
    '/missing.woff2',
    '/missing.wasm',
    '/favicon.ico',
  ])('returns 404 for missing path with asset extension: %s', async (p) => {
    const r = await probe(app, p);
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  // `.json` is NOT in ASSET_EXT_RE on purpose — see the comment on the
  // regex and the dedicated test below. A non-`/api` path ending in
  // `.json` (future static manifests, etc.) should fall through to
  // express's normal handler chain rather than being 404'd by the SPA
  // fallback. Pin that behavior so a future regex "cleanup" can't
  // silently re-introduce the bug.
  it('does NOT 404 a non-api path ending in .json (regression: see ASSET_EXT_RE)', async () => {
    const r = await probe(app, '/some-data.json');
    // The SPA fallback should NOT 404 — it should let express's normal
    // handler chain resolve the path. With no actual handler in this
    // minimal test app, that means the SPA catch-all serves index.html
    // (200 / text/html). The important assertion is the negative: it
    // wasn't 404'd by ASSET_EXT_RE classifying `.json` as an asset.
    expect(r.status).not.toBe(404);
    expect(ASSET_EXT_RE.test('/some-data.json')).toBe(false);
  });

  it('does NOT intercept /api/* routes', async () => {
    const r = await probe(app, '/api/storage/health');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/application\/json/);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok' });
  });

  it('does NOT intercept /health', async () => {
    const r = await probe(app, '/health');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/application\/json/);
  });

  it('returns index.html for paths without a dot (real client-side route)', async () => {
    const r = await probe(app, '/evaluations/benchmarks');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
  });

  it('falls through (does not return SPA shell) for non-GET methods', async () => {
    // POST /assets/foo.js should not return index.html. With no POST route
    // registered, Express's default 404 handler kicks in.
    const r = await probe(app, '/assets/foo.js', 'POST');
    expect(r.status).toBe(404);
    // Default Express 404 is text/html "Cannot POST /assets/foo.js" — we just
    // assert it's NOT the SPA shell (which contains '<div id="root">').
    expect(r.body).not.toContain('<div id="root">');
  });
});

describe('makeSpaFallbackMiddleware — live index.html refresh (rebuild-without-restart bug)', () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-fallback-refresh-test-'));
    indexPath = path.join(tmpDir, 'index.html');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves the NEW html after the file changes and its mtime advances (no restart needed)', async () => {
    const oldHtml = '<html><body><script src="/assets/index-OLDHASH.js"></script></body></html>';
    const newHtml = '<html><body><script src="/assets/index-NEWHASH.js"></script></body></html>';

    fs.writeFileSync(indexPath, oldHtml, 'utf-8');
    const app = buildApp(indexPath);

    const before = await probe(app, '/app');
    expect(before.body).toBe(oldHtml);

    // Simulate an in-place rebuild: new content, mtime strictly advanced.
    touchWithContent(indexPath, newHtml, 1000);

    const after = await probe(app, '/app');
    expect(after.body).toBe(newHtml);
    expect(after.body).not.toContain('OLDHASH');
  });

  it('keeps serving the cached html when the mtime has NOT changed (no redundant re-read)', async () => {
    const html = '<html><body>stable</body></html>';
    fs.writeFileSync(indexPath, html, 'utf-8');
    const app = buildApp(indexPath);

    const readSpy = jest.spyOn(fs, 'readFileSync');
    readSpy.mockClear();

    const r1 = await probe(app, '/one');
    const r2 = await probe(app, '/two');
    expect(r1.body).toBe(html);
    expect(r2.body).toBe(html);

    // Two requests, unchanged mtime: readFileSync must not be called again
    // beyond the middleware's own initial synchronous load (which happened
    // in buildApp(), before the spy was installed). Both probed requests
    // should be served purely from the mtime-checked cache.
    expect(readSpy).not.toHaveBeenCalled();

    readSpy.mockRestore();
  });

  it('serves the last-good cached html if a later read fails (mid-rebuild transient error)', async () => {
    const goodHtml = '<html><body>good</body></html>';
    fs.writeFileSync(indexPath, goodHtml, 'utf-8');
    const app = buildApp(indexPath);

    // Warm the cache with a real, successful request.
    const warm = await probe(app, '/warm');
    expect(warm.body).toBe(goodHtml);

    // Force the *next* stat to look like a changed file (so a re-read is
    // attempted) but make the read itself throw, simulating a rebuild tool
    // truncating/replacing the file mid-write.
    const realStat = fs.statSync;
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementationOnce(((p: Parameters<typeof fs.statSync>[0]) => {
      const real = realStat(p);
      return { ...real, mtimeMs: real.mtimeMs + 999999 } as fs.Stats;
    }) as typeof fs.statSync);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('EBUSY: file is being rewritten');
    });

    const duringRebuild = await probe(app, '/during-rebuild');
    expect(duringRebuild.status).toBe(200);
    expect(duringRebuild.body).toBe(goodHtml); // last-good, not a 500/blank

    statSpy.mockRestore();
    readSpy.mockRestore();

    // Once the rebuild tool finishes and mtime genuinely differs again, a
    // normal request should pick up the fresh content.
    touchWithContent(indexPath, '<html><body>after rebuild</body></html>', 2000);
    const after = await probe(app, '/after-rebuild');
    expect(after.body).toBe('<html><body>after rebuild</body></html>');
  });

  it('returns 503 (never a blank 200) if the file never successfully reads at all', async () => {
    // Never created — index.html does not exist at any point.
    const app = buildApp(indexPath);
    const r = await probe(app, '/anything');
    expect(r.status).toBe(503);
    expect(r.contentType).not.toMatch(/text\/html/);
  });
});

describe('ASSET_EXT_RE', () => {
  it('matches all common web asset extensions (case-insensitive)', () => {
    const cases = [
      'foo.js', 'foo.mjs', 'foo.cjs', 'foo.css', 'foo.map',
      'foo.wasm', 'foo.ico', 'foo.png', 'foo.JPG', 'foo.svg', 'foo.WOFF2',
      'foo.ttf', 'foo.otf', 'foo.mp4', 'foo.webm', 'foo.txt', 'foo.pdf',
    ];
    for (const c of cases) expect(ASSET_EXT_RE.test(c)).toBe(true);
  });

  it('does NOT match .json (regression: API endpoints with .json in the path must not be classified as assets)', () => {
    expect(ASSET_EXT_RE.test('foo.json')).toBe(false);
    expect(ASSET_EXT_RE.test('/api/data.json')).toBe(false);
    expect(ASSET_EXT_RE.test('/manifest.json')).toBe(false);
  });

  it('does not match plain client-side route segments', () => {
    expect(ASSET_EXT_RE.test('/evaluations/benchmarks')).toBe(false);
    expect(ASSET_EXT_RE.test('/run-1234-abc')).toBe(false);
    expect(ASSET_EXT_RE.test('/')).toBe(false);
  });
});
