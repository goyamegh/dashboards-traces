/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admin Routes for Storage API
 * Handles health checks, index initialization, stats, and backfill operations.
 *
 * Uses the storage adapter for health checks and analytics backfill.
 * OpenSearch-specific operations (init-indexes) still use raw client when available.
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { INDEX_MAPPINGS } from '../../constants/indexMappings';
import { getStorageModule, testStorageConnection, isFileStorage, setStorageModule, OpenSearchStorageModule, FileStorageModule } from '../../adapters/index.js';
import { Client } from '@opensearch-project/opensearch';
import { resolveStorageConfig } from '../../middleware/dataSourceConfig.js';
import { debug } from '@/lib/debug';
import {
  getConfigStatus,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
} from '../../services/configService.js';

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
 * POST /api/storage/test-connection
 * Test connection to a storage cluster with provided credentials
 * Falls back to env vars for any missing fields
 * Body: { endpoint, username?, password?, tlsSkipVerify? }
 */
router.post('/api/storage/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    const result = await testStorageConnection({
      endpoint,
      username: username ?? process.env.OPENSEARCH_STORAGE_USERNAME,
      password: password ?? process.env.OPENSEARCH_STORAGE_PASSWORD,
      tlsSkipVerify: tlsSkipVerify ?? (process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true'),
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
    const results: Record<string, any> = {};

    for (const [indexName, mapping] of Object.entries(INDEX_MAPPINGS)) {
      try {
        // Check if index exists
        const exists = await client.indices.exists({ index: indexName });
        if (exists.body) {
          results[indexName] = { status: 'exists' };
          continue;
        }

        await client.indices.create({ index: indexName, body: mapping as any });
        results[indexName] = { status: 'created' };
        debug('StorageAPI', `Created index: ${indexName}`);
      } catch (error: any) {
        results[indexName] = { status: 'error', error: error.message };
        console.error(`[StorageAPI] Failed to create index ${indexName}:`, error.message);
      }
    }

    res.json({ success: true, results });
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
    const status = getConfigStatus();
    res.json(status);
  } catch (error: any) {
    console.error('[StorageAPI] Failed to get config status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/storage
 * Save storage configuration to file
 * Body: { endpoint, username?, password?, tlsSkipVerify? }
 */
router.post('/api/storage/config/storage', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveStorageConfig({ endpoint, username, password, tlsSkipVerify });

    const clientConfig: any = {
      node: endpoint,
      ssl: { rejectUnauthorized: !(tlsSkipVerify === true) },
    };
    if (username && password) {
      clientConfig.auth = { username, password };
    }
    const client = new Client(clientConfig);
    setStorageModule(new OpenSearchStorageModule(client));

    res.json({ success: true, message: 'Storage configuration saved', connected: true });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/observability
 * Save observability configuration to file
 * Body: { endpoint, username?, password?, tlsSkipVerify?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, indexes } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveObservabilityConfig({ endpoint, username, password, tlsSkipVerify, indexes });
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
    clearStorageConfig();
    setStorageModule(new FileStorageModule());
    res.json({ success: true, message: 'Storage configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/observability
 * Clear observability configuration from file
 */
router.delete('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    clearObservabilityConfig();
    res.json({ success: true, message: 'Observability configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear observability config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
