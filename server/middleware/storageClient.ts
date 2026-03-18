/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Client Middleware
 *
 * Resolves storage configuration from request headers or environment variables
 * and attaches an OpenSearch client to the request object.
 *
 * This enables dynamic data source configuration from the UI while
 * maintaining efficient client pooling.
 */

import { Request, Response, NextFunction } from 'express';
import { Client } from '@opensearch-project/opensearch';
import { resolveStorageConfig } from './dataSourceConfig.js';
import { createOpenSearchClient, configToCacheKey } from '../services/opensearchClientFactory.js';
import { getStorageState } from '../adapters/index.js';
import { initializeStorageFromConfig } from '../services/storageInitializer.js';
import type { StorageClusterConfig } from '../../types/index.js';

// Client cache keyed by endpoint+credentials (avoids creating new clients per request)
interface CachedClient {
  client: Client;
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get an existing client from cache or create a new one
 */
function getOrCreateClient(config: StorageClusterConfig): Client {
  const key = configToCacheKey(config);
  const cached = clientCache.get(key);

  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  const client = createOpenSearchClient(config);
  clientCache.set(key, { client, lastUsed: Date.now() });

  return client;
}

/**
 * Cleanup expired clients every minute
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache.entries()) {
    if (now - entry.lastUsed > CLIENT_TTL_MS) {
      entry.client.close().catch(() => {
        // Ignore close errors
      });
      clientCache.delete(key);
    }
  }
}, 60 * 1000);

// ============================================================================
// Drift Detection
// ============================================================================

const DRIFT_DEBOUNCE_MS = 5_000;
let lastDriftCheckTime = 0;
let driftReinitPromise: Promise<void> | null = null;

/**
 * Check if the on-disk config has drifted from the runtime storage state.
 * If so, trigger a non-blocking reinit (current request proceeds with existing module).
 * Debounced to avoid hammering the filesystem on every request.
 */
function checkForConfigDrift(config: StorageClusterConfig | null): void {
  const now = Date.now();
  if (now - lastDriftCheckTime < DRIFT_DEBOUNCE_MS) return;
  lastDriftCheckTime = now;

  const currentState = getStorageState();
  const newConfigKey = config ? configToCacheKey(config) : null;

  // No drift if keys match (both null = file storage, both same string = same OpenSearch config)
  if (newConfigKey === currentState.configKey) return;

  // Skip if a file-override sentinel is active (set by "Use File Storage" button)
  if (currentState.configKey === '__file_override__') return;

  // Already reinitializing — coalesce
  if (driftReinitPromise) return;

  console.log('[storageClient] Config drift detected, reinitializing storage...');
  driftReinitPromise = initializeStorageFromConfig(config)
    .then((state) => {
      if (state.backend === 'error') {
        console.warn(`[storageClient] Drift reinit failed: ${state.error}`);
      } else {
        console.log(`[storageClient] Drift reinit complete: ${state.backend}`);
      }
    })
    .catch((err) => {
      console.error('[storageClient] Drift reinit unexpected error:', err);
    })
    .finally(() => {
      driftReinitPromise = null;
    });
}

// Exported for testing
export function _resetDriftState(): void {
  lastDriftCheckTime = 0;
  driftReinitPromise = null;
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Storage client middleware
 *
 * Attaches req.storageClient and req.storageConfig to the request object.
 * These are null if storage is not configured.
 * Also checks for config drift and triggers async reinit if needed.
 */
export function storageClientMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const config = resolveStorageConfig(req);

  if (config) {
    req.storageClient = getOrCreateClient(config);
    req.storageConfig = config;
  } else {
    req.storageClient = null;
    req.storageConfig = null;
  }

  // Non-blocking drift detection
  checkForConfigDrift(config);

  next();
}

/**
 * Check if storage is available for the current request
 */
export function isStorageAvailable(req: Request): boolean {
  return req.storageClient !== null;
}

/**
 * Get the storage client from the request, throwing if not configured
 */
export function requireStorageClient(req: Request): Client {
  if (!req.storageClient) {
    throw new Error('Storage not configured');
  }
  return req.storageClient;
}

/**
 * Get the storage client from the request, returning null if not configured
 */
export function getStorageClient(req: Request): Client | null {
  return req.storageClient;
}

/**
 * Index names for storage (same as opensearchClient.ts for consistency)
 * Note: benchmarks key uses old index name 'evals_experiments' for data compatibility
 */
export const INDEXES = {
  testCases: 'evals_test_cases',
  benchmarks: 'evals_experiments',
  runs: 'evals_runs',
  analytics: 'evals_analytics',
} as const;

export type IndexName = (typeof INDEXES)[keyof typeof INDEXES];
