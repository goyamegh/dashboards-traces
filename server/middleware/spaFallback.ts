/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPA fallback middleware factory.
 *
 * Lives in its own module so unit tests can import it without dragging in
 * `server/middleware/index.ts`'s top-level `import.meta.url` (which breaks
 * under ts-jest's CJS transform).
 *
 * Asset paths (anything under /assets/, /static/, or with a typical web-asset
 * extension) are explicitly *not* served as the SPA shell. If
 * `express.static` already handled the asset, this middleware never sees it;
 * if not, returning index.html (text/html) for an asset request produces:
 *
 *   "Failed to load module script: Expected a JavaScript-or-Wasm module
 *    script but the server responded with a MIME type of \"text/html\".
 *    Strict MIME type checking is enforced for module scripts per HTML
 *    spec."
 *
 * which leaves the user with a blank page after every deploy whenever their
 * browser cached an `index.html` that points at a now-replaced asset hash.
 */

import fs from 'fs';
import type { Request, Response, NextFunction } from 'express';

// Anything ending in a typical web-asset extension is treated as a static
// asset request, not a client-side route. If express.static didn't already
// serve it, it doesn't exist — return 404, never index.html.
//
// `.json` is deliberately omitted: API endpoints with `.json` in the path
// (e.g., `/api/data.json`, future static manifest endpoints) are passed
// through to express's normal handlers. The `/api/*` short-circuit above
// already covers most of these, but keeping `.json` out of this regex
// also protects custom mounts under non-`/api` prefixes.
export const ASSET_EXT_RE =
  /\.(?:js|mjs|cjs|css|map|wasm|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|txt|xml|pdf)$/i;

interface HtmlCache {
  html: string;
  mtimeMs: number;
}

/**
 * Re-reads `indexPath` whenever its on-disk mtime changes, and otherwise
 * serves the last-good cached body.
 *
 * This is what fixes the "stale index.html after an in-place rebuild" bug:
 * the old implementation read `dist/index.html` into a string ONCE at
 * process boot, so a later `npm run build` in the same worktree/process
 * would rehash `dist/assets/*` while the cached HTML kept pointing at the
 * now-deleted old asset hashes — every SPA route served blank (JS/CSS 404s)
 * until the process restarted.
 *
 * `fs.statSync` runs on every request (cheap — a single stat syscall at
 * this traffic level) so a change is picked up on the very next request,
 * no polling delay. If the stat/read fails (e.g. mid-rebuild, the file is
 * briefly missing or truncated), the last-good cached HTML — if any — is
 * served instead of a 500 or a blank response.
 */
function makeHtmlSource(indexPath: string): () => string | null {
  let cache: HtmlCache | null = null;

  // Best-effort initial synchronous load. Failure here just means `cache`
  // stays null until a later request's refresh succeeds — never throws.
  try {
    const stat = fs.statSync(indexPath);
    cache = { html: fs.readFileSync(indexPath, 'utf-8'), mtimeMs: stat.mtimeMs };
  } catch {
    cache = null;
  }

  return function getHtml(): string | null {
    try {
      const stat = fs.statSync(indexPath);
      if (!cache || stat.mtimeMs !== cache.mtimeMs) {
        const html = fs.readFileSync(indexPath, 'utf-8');
        cache = { html, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Stat/read failed — e.g. dist/ is mid-rebuild and the file is
      // briefly missing/truncated. Keep serving the last-good cache.
    }
    return cache ? cache.html : null;
  };
}

/**
 * Pure SPA-fallback middleware factory. Pass the on-disk path to
 * `index.html` (NOT its contents — see module doc above) and you get back a
 * request handler that:
 *   - passes /api/* and /health through untouched
 *   - 404s for anything under /assets/ or /static/
 *   - 404s for any path that ends in a known asset extension
 *   - 404s for non-GET/HEAD methods (lets Express's default 404 handle them)
 *   - serves the CURRENT index.html (text/html) for everything else,
 *     re-reading it whenever its mtime changes and falling back to the
 *     last-good copy if a read/stat fails
 */
export function makeSpaFallbackMiddleware(indexPath: string) {
  const getHtml = makeHtmlSource(indexPath);

  return function spaFallback(req: Request, res: Response, next: NextFunction) {
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return next();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    if (req.path.startsWith('/assets/') || req.path.startsWith('/static/')) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    if (ASSET_EXT_RE.test(req.path)) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    const html = getHtml();
    if (html == null) {
      // Never successfully read — not even at startup — so there's no
      // last-good cache to fall back to. Surface a 503 rather than a
      // blank/broken 200.
      return res.status(503).type('text/plain').send('Service Unavailable');
    }
    res.type('html').send(html);
  };
}
