/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reject brotli-encoded request bodies before `express.json()` can inflate them.
 *
 * Defence-in-depth for CVE-2026-111497 (Node.js brotli decoder out-of-bounds
 * write → remote code execution; fixed in Node 22.23.4 / 24.22.1 / 26.12.1).
 * body-parser defaults to `inflate: true` and maps `Content-Encoding: br` onto
 * `zlib.createBrotliDecompress()`, so any client reaching the AG-UI HTTP
 * server could feed attacker-chosen bytes to the vulnerable decoder. The real
 * fix is running a patched Node (see `.nvmrc`); this closes the request-body
 * path regardless of runtime. gzip / deflate / identity are untouched.
 *
 * Standalone copy of agent-health's `server/middleware/rejectBrotliBodies.ts`
 * (this sample agent is its own package and cannot import from the root).
 */

import type { Request, Response, NextFunction } from 'express';

export const UNSUPPORTED_CONTENT_ENCODING_CODE = 'UNSUPPORTED_CONTENT_ENCODING';

export function namesBrotliEncoding(headerValue: string | string[] | undefined): boolean {
  if (headerValue === undefined) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  return raw.split(',').some((coding) => coding.trim().toLowerCase() === 'br');
}

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
