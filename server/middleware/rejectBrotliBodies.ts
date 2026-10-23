/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reject brotli-encoded request bodies before any body parser can inflate them.
 *
 * Defence-in-depth for CVE-2026-111497 (Node.js brotli decoder out-of-bounds
 * write → remote code execution; fixed in Node 22.23.4 / 24.22.1 / 26.12.1):
 * body-parser (which backs `express.json()` and friends) defaults to
 * `inflate: true` and maps `Content-Encoding: br` straight onto
 * `zlib.createBrotliDecompress()`, so any client that can reach any JSON
 * route — the server has no authentication of its own — could feed
 * attacker-chosen bytes into the vulnerable decoder. The REAL fix is running a
 * patched Node (see `engines.node` in package.json); this middleware closes the
 * request-body path regardless of the runtime, and costs nothing because none
 * of agent-health's own clients (UI, CLI, SDK, OTLP exporters, which only use
 * gzip) ever send brotli-compressed request bodies.
 *
 * gzip / deflate / identity are untouched. Mount it BEFORE every body parser.
 */

import type { Request, Response, NextFunction } from 'express';

export const UNSUPPORTED_CONTENT_ENCODING_CODE = 'UNSUPPORTED_CONTENT_ENCODING';

/**
 * True when the Content-Encoding header value names brotli (`br`) as any one
 * of its (possibly comma-separated) codings, case-insensitively — e.g. `br`,
 * `BR`, `gzip, br`. Anything else (including no header) is false.
 */
export function namesBrotliEncoding(headerValue: string | string[] | undefined): boolean {
  if (headerValue === undefined) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  return raw
    .split(',')
    .some((coding) => coding.trim().toLowerCase() === 'br');
}

/**
 * Express middleware: 415 + JSON error for any request whose Content-Encoding
 * includes `br`; otherwise pass through untouched.
 */
export function rejectBrotliRequestBodies(req: Request, res: Response, next: NextFunction): void {
  if (!namesBrotliEncoding(req.headers['content-encoding'])) {
    next();
    return;
  }
  res.status(415).json({
    error: 'Unsupported Content-Encoding: br (brotli request bodies are not accepted; send the body uncompressed or gzip-encoded)',
    code: UNSUPPORTED_CONTENT_ENCODING_CODE,
  });
}
