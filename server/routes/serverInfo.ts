/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server Info Route
 *
 * Lightweight metadata endpoint surfacing things the UI wants to know on
 * first paint: the active storage backend, the result of the most recent
 * cold-start migrations, and the SDK experimental flag. Replaces the need
 * for a separate /api/migrations or /api/storage/info surface.
 */

import { Request, Response, Router } from 'express';
import { getVersion } from '../utils/version.js';
import { getStorageState } from '../adapters/index.js';
import { getLastMigrationStats } from '../services/coldStartMigrations.js';

const router = Router();

router.get('/api/server-info', (_req: Request, res: Response) => {
  const storage = getStorageState();
  const migrations = getLastMigrationStats();
  res.json({
    version: getVersion(),
    storage: {
      backend: storage.backend,
      configured: !!storage.configuredEndpoint,
      error: storage.error,
    },
    migrations: migrations.map(m => ({
      name: m.name,
      ran: m.ran,
      scanned: m.scanned,
      updated: m.updated,
      skipped: m.skipped,
      errors: m.errors,
      durationMs: m.durationMs,
      // notes are intentionally excluded from the wire format \u2014 they may
      // include error stack trails. Surface them in server logs only.
    })),
    sdk: {
      experimental: true,
    },
  });
});

export default router;
