/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability Routes
 *
 * Handles observability data source configuration and health checks.
 * Test connection endpoint for OTEL instrumentation data sources.
 */

import { Router, Request, Response } from 'express';
import { testObservabilityConnection, checkObservabilityHealth } from '../adapters/index.js';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { getObservabilityConfigFromFile } from '../services/configService.js';

const router = Router();

// ============================================================================
// Health Check
// ============================================================================

/**
 * GET /api/observability/health
 * Check observability data source health
 * Uses headers for config, falls back to env vars
 */
router.get('/api/observability/health', async (req: Request, res: Response) => {
  try {
    const config = resolveObservabilityConfig(req);
    const result = await checkObservabilityHealth(config);
    res.json(result);
  } catch (error: any) {
    console.error('[ObservabilityAPI] Health check failed:', error.message);
    res.json({ status: 'error', error: error.message });
  }
});

// ============================================================================
// Test Connection
// ============================================================================

/**
 * POST /api/observability/test-connection
 * Test connection to an observability data source with provided credentials
 * Body: { endpoint, username?, password?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/observability/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    // Fall back to file config, then env vars, for any missing credentials
    const fileConfig = getObservabilityConfigFromFile();

    const result = await testObservabilityConnection({
      endpoint,
      authType: authType ?? fileConfig?.authType ?? process.env.OPENSEARCH_LOGS_AUTH_TYPE,
      username: username ?? fileConfig?.username ?? process.env.OPENSEARCH_LOGS_USERNAME,
      password: password ?? fileConfig?.password ?? process.env.OPENSEARCH_LOGS_PASSWORD,
      awsProfile: awsProfile ?? fileConfig?.awsProfile ?? process.env.OPENSEARCH_LOGS_AWS_PROFILE,
      awsRegion: awsRegion ?? fileConfig?.awsRegion ?? process.env.OPENSEARCH_LOGS_AWS_REGION,
      awsService: awsService ?? fileConfig?.awsService ?? process.env.OPENSEARCH_LOGS_AWS_SERVICE,
      tlsSkipVerify: tlsSkipVerify ?? fileConfig?.tlsSkipVerify ?? (process.env.OPENSEARCH_LOGS_TLS_SKIP_VERIFY === 'true'),
      indexes: {
        traces: indexes?.traces || fileConfig?.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
        logs: indexes?.logs || fileConfig?.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
        metrics: indexes?.metrics || fileConfig?.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
      },
    });

    res.json(result);
  } catch (error: any) {
    console.error('[ObservabilityAPI] Test connection failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// Configuration Info
// ============================================================================

/**
 * GET /api/observability/defaults
 * Get default OTEL index patterns
 */
router.get('/api/observability/defaults', (_req: Request, res: Response) => {
  res.json({
    indexes: DEFAULT_OTEL_INDEXES,
  });
});

export default router;
