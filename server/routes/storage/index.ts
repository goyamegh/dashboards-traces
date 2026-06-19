/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Routes - Combines all entity routes
 * Uses OpenSearch JS SDK for all operations
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import adminRoutes from './admin';
import testCasesRoutes from './testCases';
import benchmarksRoutes from './benchmarks';
import evaluationRunsRoutes from './evaluationRuns';
import runsRoutes from './runs';
import analyticsRoutes from './analytics';
import reportsRoutes from './reports';
import evaluatorsRoutes from './evaluators';
import { getStorageState } from '../../adapters/index.js';

const router = Router();

// Admin routes (health, test-connection, config save/retry/use-file-storage,
// recovery) MUST stay reachable even when the configured cluster is down —
// they are how an operator diagnoses and fixes it.
router.use(adminRoutes);

/**
 * No-silent-fallback guard (storage error state).
 *
 * When a storage cluster IS configured but unreachable, `getStorageModule()`
 * still points at the default `FileStorageModule`, so entity CRUD would
 * silently read/write LOCAL file data while `server-info` reports
 * `backend: error` — a split-brain that violates the "a configured cluster is
 * always authoritative; a broken cluster surfaces an error, never a silent
 * fallback to disk" invariant. Refuse data CRUD with 503 instead of serving
 * misleading local data. (Config/recovery admin routes above are exempt.)
 */
router.use((req: Request, res: Response, next: NextFunction) => {
  const s = getStorageState();
  if (s.backend === 'error') {
    return res.status(503).json({
      error: 'storage_unavailable',
      message:
        `Configured OpenSearch storage (${s.configuredEndpoint}) is unreachable: ${s.error}. ` +
        `Refusing to silently read/write local file data. Fix the cluster then ` +
        `POST /api/storage/config/retry, or POST /api/storage/config/use-file-storage to switch to local files.`,
      backend: 'error',
      configuredEndpoint: s.configuredEndpoint,
    });
  }
  next();
});

router.use(testCasesRoutes);
router.use(benchmarksRoutes);
router.use(evaluationRunsRoutes);
router.use(runsRoutes);
router.use(analyticsRoutes);
router.use(reportsRoutes);
router.use(evaluatorsRoutes);

export default router;
