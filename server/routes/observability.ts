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
 * Normalize an endpoint URL for safe comparison: trims trailing slashes and
 * lowercases the value. Returns undefined for empty/missing inputs.
 */
function normalizeEndpoint(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * POST /api/observability/test-connection
 * Test connection to an observability data source with provided credentials.
 *
 * Credential resolution order: request body → file config → env vars.
 *
 * Stored credentials (file config / env vars) are only used as fallbacks when
 * the request `endpoint` matches the corresponding configured endpoint. This
 * prevents sending saved credentials to an arbitrary endpoint specified in the
 * request body (credential exfiltration). Callers wanting to test a different
 * endpoint must provide credentials explicitly in the request body. Index
 * pattern fallbacks are not credentials and are always honored.
 *
 * Body: { endpoint, username?, password?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/observability/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    // Only fall back to stored credentials when the request endpoint matches
    // the configured endpoint, to avoid forwarding saved creds to other hosts.
    const fileConfig = getObservabilityConfigFromFile();
    const envEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    const reqNorm = normalizeEndpoint(endpoint);
    const fileMatches = !!(fileConfig?.endpoint && normalizeEndpoint(fileConfig.endpoint) === reqNorm);
    const envMatches = !!(envEndpoint && normalizeEndpoint(envEndpoint) === reqNorm);

    const safeFile = fileMatches ? fileConfig : null;
    const useEnv = envMatches;

    const result = await testObservabilityConnection({
      endpoint,
      authType: authType ?? safeFile?.authType ?? (useEnv ? process.env.OPENSEARCH_LOGS_AUTH_TYPE : undefined),
      username: username ?? safeFile?.username ?? (useEnv ? process.env.OPENSEARCH_LOGS_USERNAME : undefined),
      password: password ?? safeFile?.password ?? (useEnv ? process.env.OPENSEARCH_LOGS_PASSWORD : undefined),
      awsProfile: awsProfile ?? safeFile?.awsProfile ?? (useEnv ? process.env.OPENSEARCH_LOGS_AWS_PROFILE : undefined),
      awsRegion: awsRegion ?? safeFile?.awsRegion ?? (useEnv ? process.env.OPENSEARCH_LOGS_AWS_REGION : undefined),
      awsService: awsService ?? safeFile?.awsService ?? (useEnv ? process.env.OPENSEARCH_LOGS_AWS_SERVICE : undefined),
      tlsSkipVerify: tlsSkipVerify ?? safeFile?.tlsSkipVerify ?? (useEnv ? (process.env.OPENSEARCH_LOGS_TLS_SKIP_VERIFY === 'true') : undefined),
      // Index patterns aren't credentials — always allow file-config fallback.
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
