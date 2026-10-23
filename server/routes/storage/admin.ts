/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admin Routes for Storage API
 * Handles health checks, index initialization, stats, and backfill operations.
 *
 * Uses the storage adapter for health checks and analytics backfill.
 * Index initialization is delegated to the indexInitializer service.
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { INDEX_MAPPINGS } from '../../constants/indexMappings';
import { getStorageModule, testStorageConnection, isFileStorage, setStorageModule, getStorageState, OpenSearchStorageModule, FileStorageModule, FileSessionMetadataOperations } from '../../adapters/index.js';
import type { StorageState } from '../../adapters/index.js';
import { loadConfigSync } from '@/lib/config/index';
import { resolveStorageConfig } from '../../middleware/dataSourceConfig.js';
import { createOpenSearchClient, configToCacheKey } from '../../services/opensearchClientFactory.js';
import { debug } from '@/lib/debug';
import { ensureIndexes, ensureIndexesWithValidation } from '../../services/indexInitializer.js';
import { reindexSingleIndex } from '../../services/mappingFixer.js';
import { initializeStorageFromConfig } from '../../services/storageInitializer.js';
import {
  getConfigStatus,
  saveObservabilitySource,
  deleteObservabilitySource,
  getStorageConfigFromFile,
  getStorageConfigFromTs,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
} from '../../services/configService.js';
import { getStorageConfigFromEnv } from '../../middleware/dataSourceConfig.js';
import { isCodeFirstMode } from '@/lib/config/statePaths';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: any) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// ============================================================================
// Health Check
// ============================================================================

router.get('/api/storage/health', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const health = await storage.health();

    // If using file storage, also check if OpenSearch is configured
    if (isFileStorage()) {
      const config = resolveStorageConfig(req);
      if (config) {
        // OpenSearch is configured but file storage is active
        // Check OpenSearch connectivity for the UI
        const osResult = await testStorageConnection(config);
        return res.json({
          status: health.status,
          backend: 'file',
          opensearch: osResult,
        });
      }
      return res.json({
        status: health.status,
        backend: 'file',
      });
    }

    // OpenSearch storage module active
    return res.json(health);
  } catch (error: any) {
    console.error('[StorageAPI] Health check failed:', error.message);
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
 * POST /api/storage/test-connection
 * Test connection to a storage cluster with provided credentials.
 *
 * Credential resolution order: request body → file config → TS config → env vars.
 *
 * Stored credentials (file config / TS config / env vars) are only used as fallbacks when
 * the request `endpoint` matches the corresponding configured endpoint. This
 * prevents sending saved credentials to an arbitrary endpoint specified in the
 * request body (credential exfiltration). Callers wanting to test a different
 * endpoint must provide credentials explicitly in the request body.
 *
 * Body: { endpoint, username?, password?, tlsSkipVerify?, authType?, awsProfile?, awsRegion?, awsService? }
 */
router.post('/api/storage/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    // Only fall back to stored credentials when the request endpoint matches
    // the configured endpoint, to avoid forwarding saved creds to other hosts.
    const fileConfig = getStorageConfigFromFile();
    const tsConfig = getStorageConfigFromTs();
    const envEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
    const reqNorm = normalizeEndpoint(endpoint);
    const fileMatches = !!(fileConfig?.endpoint && normalizeEndpoint(fileConfig.endpoint) === reqNorm);
    const tsMatches = !!(tsConfig?.endpoint && normalizeEndpoint(tsConfig.endpoint) === reqNorm);
    const envMatches = !!(envEndpoint && normalizeEndpoint(envEndpoint) === reqNorm);

    const safeFile = fileMatches ? fileConfig : null;
    const safeTs = tsMatches ? tsConfig : null;
    const useEnv = envMatches;

    const result = await testStorageConnection({
      endpoint,
      authType: authType ?? safeFile?.authType ?? safeTs?.authType ?? (useEnv ? process.env.OPENSEARCH_STORAGE_AUTH_TYPE : undefined),
      username: username ?? safeFile?.username ?? safeTs?.username ?? (useEnv ? process.env.OPENSEARCH_STORAGE_USERNAME : undefined),
      password: password ?? safeFile?.password ?? safeTs?.password ?? (useEnv ? process.env.OPENSEARCH_STORAGE_PASSWORD : undefined),
      awsProfile: awsProfile ?? safeFile?.awsProfile ?? safeTs?.awsProfile ?? (useEnv ? process.env.OPENSEARCH_STORAGE_AWS_PROFILE : undefined),
      awsRegion: awsRegion ?? safeFile?.awsRegion ?? safeTs?.awsRegion ?? (useEnv ? process.env.OPENSEARCH_STORAGE_AWS_REGION : undefined),
      awsService: awsService ?? safeFile?.awsService ?? safeTs?.awsService ?? (useEnv ? process.env.OPENSEARCH_STORAGE_AWS_SERVICE : undefined),
      tlsSkipVerify: tlsSkipVerify ?? safeFile?.tlsSkipVerify ?? safeTs?.tlsSkipVerify ?? (useEnv ? (process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true') : undefined),
    });
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Test connection failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// Initialize Indexes (OpenSearch-specific)
// ============================================================================

router.post(
  '/api/storage/init-indexes',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured. File storage does not require index initialization.' });
    }

    const client = requireStorageClient(req);
    const results = await ensureIndexes(client);

    res.json({ success: true, results });
  })
);

// ============================================================================
// Reindex (migrate existing index to correct mappings)
// ============================================================================

/**
 * POST /api/storage/reindex
 * Reindex an existing index to apply correct mappings.
 * Delegates to reindexSingleIndex() in mappingFixer service.
 * Body: { index: string } — the index name to reindex (must be in INDEX_MAPPINGS)
 */
router.post(
  '/api/storage/reindex',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured.' });
    }

    const { index: indexName } = req.body;
    if (!indexName || typeof indexName !== 'string') {
      return res.status(400).json({ error: 'index is required in request body' });
    }

    const mapping = INDEX_MAPPINGS[indexName];
    if (!mapping) {
      return res.status(400).json({ error: `Unknown index: ${indexName}. Must be one of: ${Object.keys(INDEX_MAPPINGS).join(', ')}` });
    }

    const client = requireStorageClient(req);
    const tempIndex = `${indexName}_reindex_temp`;

    try {
      // Check source index exists
      const exists = await client.indices.exists({ index: indexName });
      if (!exists.body) {
        return res.status(404).json({ error: `Index ${indexName} does not exist` });
      }

      const result = await reindexSingleIndex(client, indexName);

      res.json({
        success: true,
        index: indexName,
        documentsReindexed: result.documentsReindexed,
      });
    } catch (error: any) {
      console.error(`[StorageAPI] Reindex failed for ${indexName}:`, error.message);

      // Check if temp index still exists for manual cleanup
      let tempStillExists = false;
      try {
        const check = await client.indices.exists({ index: tempIndex });
        tempStillExists = check.body;
      } catch { /* ignore */ }

      res.status(500).json({
        error: `Reindex failed: ${error.message}`,
        tempIndex: tempStillExists ? tempIndex : undefined,
        hint: tempStillExists ? `Temp index ${tempIndex} still exists with your data. Do NOT delete it manually until the original index is recovered.` : undefined,
      });
    }
  })
);

// ============================================================================
// Storage Stats
// ============================================================================

router.get(
  '/api/storage/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const storage = getStorageModule();

    if (isFileStorage()) {
      // For file storage, count files in each directory
      try {
        const tcResult = await storage.testCases.getAll();
        const benchResult = await storage.benchmarks.getAll();
        const runResult = await storage.runs.getAll();

        const stats: Record<string, any> = {
          test_cases: { count: tcResult.total },
          benchmarks: { count: benchResult.total },
          runs: { count: runResult.total },
          analytics: { count: 0 },
        };

        return res.json({ stats, backend: 'file' });
      } catch (error: any) {
        return res.json({ stats: {}, error: error.message, backend: 'file' });
      }
    }

    // OpenSearch path
    if (!isStorageAvailable(req)) {
      const stats: Record<string, any> = {};
      for (const indexName of Object.values(INDEXES)) {
        stats[indexName] = { count: 0, error: 'Storage not configured' };
      }
      return res.json({ stats });
    }

    const client = requireStorageClient(req);
    const stats: Record<string, any> = {};

    for (const indexName of Object.values(INDEXES)) {
      try {
        const result = await client.count({ index: indexName });
        stats[indexName] = { count: result.body.count };
      } catch (error: any) {
        stats[indexName] = { count: 0, error: error.message };
      }
    }

    res.json({ stats });
  })
);

// ============================================================================
// Backfill Analytics
// ============================================================================

router.post(
  '/api/storage/backfill-analytics',
  asyncHandler(async (req: Request, res: Response) => {
    const storage = getStorageModule();
    const result = await storage.analytics.backfill();

    debug('StorageAPI', `Backfilled ${result.backfilled} analytics records (${result.errors} errors)`);
    res.json(result);
  })
);

// ============================================================================
// Configuration Management
// ============================================================================

/**
 * GET /api/storage/config/status
 * Get configuration status (no credentials returned)
 */
router.get('/api/storage/config/status', (req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    const status = getConfigStatus(config.agents);
    res.json(status);
  } catch (error: any) {
    console.error('[StorageAPI] Failed to get config status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/storage
 * Save storage configuration to file and validate index mappings.
 * Returns needsReindex: true if incompatible mappings are detected.
 * Body: { endpoint, username?, password?, tlsSkipVerify? }
 */
router.post('/api/storage/config/storage', async (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    const { endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    // Finding-2 guard: reject an unrecognized authType up front with a clear
    // 400 (instead of a deferred opaque connection error) so the Settings UI
    // gives immediate, actionable feedback.
    if (authType !== undefined && authType !== 'none' && authType !== 'basic' && authType !== 'sigv4') {
      return res.status(400).json({
        error: `Invalid authType '${authType}'. Expected 'sigv4', 'basic', or 'none' (use 'sigv4' for AWS OpenSearch).`,
      });
    }

    saveStorageConfig({ endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService });

    const client = createOpenSearchClient({
      endpoint,
      authType,
      username,
      password,
      awsProfile,
      awsRegion,
      awsService,
      tlsSkipVerify: tlsSkipVerify === true,
    });

    // Auto-create indexes, validate mappings, and auto-fix if needed
    const setupResult = await ensureIndexesWithValidation(client);

    const state: StorageState = {
      backend: 'opensearch',
      configKey: configToCacheKey({ endpoint, authType, username, password, awsProfile, awsRegion, awsService, tlsSkipVerify: tlsSkipVerify === true }),
      error: null,
      configuredEndpoint: endpoint,
    };
    setStorageModule(new OpenSearchStorageModule(client, new FileSessionMetadataOperations()), state);

    const hasFixFailures = setupResult.fixResults?.some((f) => f.status === 'failed') ?? false;
    const hadIssues = setupResult.validationResults.some((r) => r.status === 'needs_reindex');
    const needsReindex = hadIssues && (hasFixFailures || !setupResult.fixResults);
    if (hasFixFailures) {
      const failedNames = setupResult.fixResults!.filter((f) => f.status === 'failed').map((f) => f.indexName);
      console.warn(`[StorageAPI] Index fix failures: ${failedNames.join(', ')}`);
    }
    res.json({
      success: true,
      message: 'Storage configuration saved',
      connected: true,
      indexResults: setupResult.indexResults,
      validationResults: setupResult.validationResults,
      fixResults: setupResult.fixResults,
      needsReindex,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/setup-indexes
 * SSE endpoint for index setup with real-time progress.
 * Validates and fixes index mappings, streaming per-index progress events.
 */
router.post(
  '/api/storage/setup-indexes',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured.' });
    }

    const client = requireStorageClient(req);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent({ type: 'started', indexes: Object.keys(INDEX_MAPPINGS) });

      const setupResult = await ensureIndexesWithValidation(client, (progress) => {
        sendEvent({ type: 'fix_progress', progress });
      });

      sendEvent({
        type: 'validation',
        results: setupResult.validationResults,
      });

      sendEvent({
        type: 'completed',
        indexResults: setupResult.indexResults,
        validationResults: setupResult.validationResults,
        fixResults: setupResult.fixResults,
      });
    } catch (error: any) {
      console.error('[StorageAPI] Setup indexes failed:', error.message);
      sendEvent({ type: 'error', error: error.message });
    } finally {
      res.end();
    }
  })
);

/**
 * PUT /api/storage/config/observability/sources/:id
 * Upsert one ADDITIONAL observability source (read side by side with the
 * primary). Same body shapes as POST /api/storage/config/observability plus
 * an optional `name`. ui-first only (409 in code-first mode).
 */
router.put('/api/storage/config/observability/sources/:id', (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    const id = String(req.params.id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || id === 'primary') {
      return res.status(400).json({ error: 'id must be 1-64 chars of letters, digits, "_", "." or "-", and not "primary"' });
    }
    const { name, type, endpoint, username, password, tlsSkipVerify, indexes, logGroups, authType, awsProfile, awsRegion, awsService } = req.body ?? {};
    if (name !== undefined && (typeof name !== 'string' || name.length > 80)) {
      return res.status(400).json({ error: 'name must be a string of at most 80 characters' });
    }
    if (type !== undefined && type !== 'opensearch' && type !== 'cloudwatch') {
      return res.status(400).json({ error: `Invalid type '${type}'. Expected 'opensearch' or 'cloudwatch'.` });
    }
    if (type === 'cloudwatch') {
      if (!awsRegion || typeof awsRegion !== 'string') return res.status(400).json({ error: 'awsRegion is required for CloudWatch' });
      saveObservabilitySource({ id, name, type: 'cloudwatch', awsRegion, awsProfile: awsProfile || undefined,
        logGroups: logGroups && (logGroups.traces || logGroups.logs) ? { ...(logGroups.traces && { traces: logGroups.traces }), ...(logGroups.logs && { logs: logGroups.logs }) } : undefined });
      return res.json({ success: true, id });
    }
    if (!endpoint || typeof endpoint !== 'string') return res.status(400).json({ error: 'Endpoint is required' });
    if (authType !== undefined && authType !== 'none' && authType !== 'basic' && authType !== 'sigv4') {
      return res.status(400).json({ error: `Invalid authType '${authType}'. Expected 'sigv4', 'basic', or 'none'.` });
    }
    saveObservabilitySource({ id, name, type: 'opensearch', endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save observability source:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/observability/sources/:id — remove an additional source.
 */
router.delete('/api/storage/config/observability/sources/:id', (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    const removed = deleteObservabilitySource(String(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Unknown observability source' });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/observability
 * Save observability configuration to the runtime state file.
 * Body (OpenSearch, default): { type?: 'opensearch', endpoint, username?, password?, tlsSkipVerify?, authType?, aws*?, indexes?: { traces?, logs?, metrics? } }
 * Body (CloudWatch):          { type: 'cloudwatch', awsRegion, awsProfile?, logGroups?: { traces?, logs? } }
 */
router.post('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    const { type, endpoint, username, password, tlsSkipVerify, indexes, logGroups, authType, awsProfile, awsRegion, awsService } = req.body;

    if (type !== undefined && type !== 'opensearch' && type !== 'cloudwatch') {
      return res.status(400).json({ error: `Invalid type '${type}'. Expected 'opensearch' or 'cloudwatch'.` });
    }

    if (type === 'cloudwatch') {
      // CloudWatch: region selects the backend; no endpoint, no basic auth.
      if (!awsRegion || typeof awsRegion !== 'string') {
        return res.status(400).json({ error: 'awsRegion is required for CloudWatch' });
      }
      for (const [k, v] of Object.entries({ awsProfile, tracesLogGroup: logGroups?.traces, logsLogGroup: logGroups?.logs })) {
        if (v !== undefined && typeof v !== 'string') {
          return res.status(400).json({ error: `${k} must be a string when provided` });
        }
      }
      saveObservabilityConfig({
        type: 'cloudwatch',
        awsRegion,
        awsProfile: awsProfile || undefined,
        logGroups: logGroups && (logGroups.traces || logGroups.logs)
          ? { ...(logGroups.traces && { traces: logGroups.traces }), ...(logGroups.logs && { logs: logGroups.logs }) }
          : undefined,
      });
      return res.json({ success: true, message: 'Observability configuration saved' });
    }

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    // Same authType guard as the storage route — reject an unrecognized value
    // up front (400) instead of persisting it and failing later as a 500.
    if (authType !== undefined && authType !== 'none' && authType !== 'basic' && authType !== 'sigv4') {
      return res.status(400).json({
        error: `Invalid authType '${authType}'. Expected 'sigv4', 'basic', or 'none' (use 'sigv4' for AWS OpenSearch).`,
      });
    }

    saveObservabilityConfig({ type: 'opensearch', endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService });
    res.json({ success: true, message: 'Observability configuration saved' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save observability config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/storage
 * Clear storage configuration from file
 */
router.delete('/api/storage/config/storage', (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    clearStorageConfig();
    const state: StorageState = {
      backend: 'file',
      configKey: null,
      error: null,
      configuredEndpoint: null,
    };
    setStorageModule(new FileStorageModule(), state);
    res.json({ success: true, message: 'Storage configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/retry
 * Re-run storage initialization from current config (file or env).
 * Used when config was edited externally or after fixing a connectivity issue.
 */
router.post('/api/storage/config/retry', async (req: Request, res: Response) => {
  try {
    const config = getStorageConfigFromFile() ?? getStorageConfigFromTs() ?? getStorageConfigFromEnv() ?? null;
    const state = await initializeStorageFromConfig(config);
    res.json({
      success: state.backend !== 'error',
      state,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Retry failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/use-file-storage
 * Force file storage regardless of config file contents.
 * Sets a sentinel config key so drift detection doesn't immediately reinit.
 */
router.post('/api/storage/config/use-file-storage', (req: Request, res: Response) => {
  try {
    const state: StorageState = {
      backend: 'file',
      configKey: '__file_override__',
      error: null,
      configuredEndpoint: null,
    };
    setStorageModule(new FileStorageModule(), state);
    res.json({ success: true, message: 'Switched to file storage' });
  } catch (error: any) {
    console.error('[StorageAPI] Use file storage failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/observability
 * Clear observability configuration from file
 */
router.delete('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    if (isCodeFirstMode()) {
      return res.status(409).json({ error: 'Data sources are managed by agent-health.config.ts (code-first mode). Edit the config file and restart.' });
    }
    clearObservabilityConfig();
    res.json({ success: true, message: 'Observability configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear observability config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/admin/recover-orphan-benchmark-runs
 *
 * Test-only endpoint: invokes the same boot-recovery logic that runs in
 * `server/index.ts` after `app.listen()`. Used by integration tests to
 * exercise the recovery path against the real storage backend without
 * needing to restart the server (or to dynamically import the OpenSearch
 * client from inside Jest, which fails under CJS transform).
 *
 * Gated behind `AGENT_HEALTH_TEST_ENDPOINTS=1` so it cannot be triggered
 * accidentally in production.
 */
router.post('/api/storage/admin/recover-orphan-benchmark-runs', async (req: Request, res: Response) => {
  if (process.env.AGENT_HEALTH_TEST_ENDPOINTS !== '1') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const storage = getStorageModule();
    if (!storage) {
      return res.status(503).json({ error: 'Storage not initialized' });
    }
    const { recoverOrphanBenchmarkRuns } = await import('../../services/benchmarkRunRecoveryOnBoot.js');
    const stat = await recoverOrphanBenchmarkRuns(storage);
    res.json(stat);
  } catch (error: any) {
    console.error('[StorageAPI] recover-orphan-benchmark-runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/admin/resume-pending-trace-polls
 * Sister test-only endpoint for the trace-recovery boot hook.
 */
router.post('/api/storage/admin/resume-pending-trace-polls', async (req: Request, res: Response) => {
  if (process.env.AGENT_HEALTH_TEST_ENDPOINTS !== '1') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const storage = getStorageModule();
    if (!storage) {
      return res.status(503).json({ error: 'Storage not initialized' });
    }
    const { resumePendingTracePolls } = await import('../../services/traceRecoveryOnBoot.js');
    const stat = await resumePendingTracePolls(storage);
    res.json(stat);
  } catch (error: any) {
    console.error('[StorageAPI] resume-pending-trace-polls failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
