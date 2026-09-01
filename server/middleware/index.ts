/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Middleware Setup - CORS, JSON parsing, and static file serving
 */

import { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { debug } from '../../lib/debug.js';
import { readEnv } from '../../lib/envCompat.js';
import { storageClientMiddleware } from './storageClient.js';
import { apiKeyAuth } from './apiKeyAuth.js';
import { makeSpaFallbackMiddleware } from './spaFallback.js';
export { makeSpaFallbackMiddleware, ASSET_EXT_RE } from './spaFallback.js';

// Get directory of this file for resolving paths relative to package location
// Server always runs from server/dist/, so path resolution is straightforward
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Setup CORS middleware
 * - Same-origin only in both dev and production
 * - Dev mode uses Vite proxy (vite.config.ts) to forward /api requests
 */
function setupCors(app: Express): void {
  const isHeadless = readEnv('AH_HEADLESS', 'AGENT_HEALTH_HEADLESS') === '1';
  app.use(cors({
    // Headless mode: allow cross-origin (remote aggregator fetches from this server)
    // Normal mode: same-origin only (dev uses Vite proxy, prod serves from same server)
    origin: isHeadless ? true : false,
    credentials: true
  }));
}

/**
 * Setup JSON body parser
 */
function setupJsonParser(app: Express): void {
  app.use(express.json({ limit: '10mb' }));

  // Regression guard (API KPI probe finding): a malformed JSON body (e.g.
  // `{not json`) on ANY route used to fall through to Express's default
  // error handler, which renders an HTML page containing the raw
  // SyntaxError stack trace (internal file paths included). body-parser's
  // JSON middleware tags well-known failures with a stable `err.type`
  // (documented, widely-relied-on body-parser behavior):
  //   - 'entity.parse.failed' -- malformed JSON syntax
  //   - 'entity.too.large'    -- body exceeded the 10mb limit above
  // Catch both here, right after the parser that can throw them, and
  // answer clean JSON instead of falling through to Express's default
  // HTML error handler.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    next(err);
  });
}

/**
 * Setup static file serving for production mode
 * Serves built frontend assets (JS, CSS, images) from dist/ folder.
 * SPA fallback is registered separately via setupSpaFallback() after routes.
 */
function setupStaticServing(app: Express): void {
  // Headless mode: pure API server, no frontend assets
  if (readEnv('AH_HEADLESS', 'AGENT_HEALTH_HEADLESS') === '1') {
    debug('StaticServer', 'Headless mode — skipping static file serving');
    return;
  }

  // From server/dist/, go up 2 levels to package root, then into dist/
  const distPath = path.join(__dirname, '..', '..', 'dist');
  const indexPath = path.join(distPath, 'index.html');
  const indexExists = fs.existsSync(indexPath);

  debug('StaticServer', '__dirname:', __dirname);
  debug('StaticServer', 'Computed distPath:', distPath);
  debug('StaticServer', 'index.html exists:', indexExists);

  if (indexExists) {
    debug('StaticServer', 'Serving frontend from dist/ folder');
    app.use(express.static(distPath, {
      index: false,  // Don't serve index.html for directory requests — let SPA fallback handle it
    }));
  } else {
    debug('StaticServer', 'dist/index.html not found - API-only mode');
  }
}

/**
 * SPA fallback - serve index.html for all non-API routes.
 * Must be registered AFTER API routes so it only catches client-side routes.
 *
 * Asset paths (anything that has a file extension or lives under /assets/ or
 * /static/) are explicitly skipped — see `./spaFallback.ts` for details.
 */
export function setupSpaFallback(app: Express): void {
  if (readEnv('AH_HEADLESS', 'AGENT_HEALTH_HEADLESS') === '1') return;

  const distPath = path.join(__dirname, '..', '..', 'dist');
  const indexPath = path.join(distPath, 'index.html');

  if (!fs.existsSync(indexPath)) return;

  // Pass the PATH, not the file's contents: the middleware re-reads
  // index.html whenever its mtime changes, so an in-place `npm run build`
  // in this same process never leaves a stale index.html pointing at
  // deleted dist/assets/* hashes. See spaFallback.ts for details.
  app.use(makeSpaFallbackMiddleware(indexPath));
}

/**
 * Setup storage client middleware
 * Attaches req.storageClient and req.storageConfig to each request
 */
function setupStorageClient(app: Express): void {
  app.use(storageClientMiddleware);
}

/**
 * Final catch-all error handler. Must be registered LAST (after routes and
 * the SPA fallback) so it catches anything an individual route handler
 * forwarded via `next(err)` as well as errors thrown by synchronous
 * middleware anywhere earlier in the chain.
 *
 * Regression guard (API KPI probe finding, F4): without this, an uncaught
 * error skips every route's own try/catch and falls through to Express's
 * built-in error handler, which renders an HTML page with the error's
 * stack trace (leaking internal file paths). This always answers JSON and
 * never includes a stack, message internals, or HTML.
 */
export function setupFinalErrorHandler(app: Express): void {
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // Response already started (e.g. mid-SSE-stream) — can't send a fresh
      // JSON body; just end the connection and let Express log it.
      return next(err);
    }
    console.error('[UnhandledError]', err?.message || err);
    res.status(err?.status && Number.isInteger(err.status) ? err.status : 500).json({
      error: 'Internal server error',
    });
  });
}

/**
 * Setup all middleware for the Express app
 */
export function setupMiddleware(app: Express): void {
  setupCors(app);
  setupJsonParser(app);
  app.use(apiKeyAuth);      // API key auth (no-op when AH_API_KEY not set)
  setupStorageClient(app);  // Add storage client before routes
  setupStaticServing(app);
}
