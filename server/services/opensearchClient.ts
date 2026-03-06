/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Client Service
 *
 * NOTE: This file provides a singleton client based on environment variables.
 * For request-scoped clients that respect UI-configured data sources, use
 * the storageClient middleware instead:
 *
 *   import { isStorageAvailable, requireStorageClient } from '../middleware/storageClient.js';
 *
 * The middleware attaches `req.storageClient` to each request after resolving
 * configuration from headers (X-Storage-*) or environment variables.
 *
 * This singleton is still useful for:
 * - Server startup logging (checking if env vars are configured)
 * - Background jobs that don't have a request context
 *
 * @see server/middleware/storageClient.ts for request-scoped clients
 */

import { Client } from '@opensearch-project/opensearch';
import { createOpenSearchClient } from './opensearchClientFactory.js';
import type { ClusterAuthType } from '../../types/index.js';

let client: Client | null = null;
let clientInitialized = false;

export interface StorageConfig {
  endpoint: string;
  username?: string;
  password?: string;
}

/**
 * Check if storage is configured
 */
export function isStorageConfigured(): boolean {
  return !!process.env.OPENSEARCH_STORAGE_ENDPOINT;
}

/**
 * Get or create the OpenSearch client singleton.
 * Returns null if storage is not configured.
 *
 * @deprecated For route handlers, use the request-scoped client from middleware:
 *   `const client = requireStorageClient(req);`
 *
 * This function only checks environment variables and doesn't respect
 * UI-configured data sources passed via headers.
 */
export function getOpenSearchClient(): Client | null {
  if (!clientInitialized) {
    clientInitialized = true;

    const endpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
    if (!endpoint) {
      // Storage not configured - sample data only mode
      return null;
    }

    const authType = (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || 'basic';

    client = createOpenSearchClient({
      endpoint,
      authType,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
      awsProfile: process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_STORAGE_AWS_REGION,
      awsService: (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined,
      tlsSkipVerify: process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true',
    });
  }
  return client;
}

/**
 * Index names for storage
 * Note: benchmarks key uses old index name 'evals_experiments' for data compatibility
 */
export const INDEXES = {
  testCases: 'evals_test_cases',
  benchmarks: 'evals_experiments',
  runs: 'evals_runs',
  analytics: 'evals_analytics',
} as const;

export type IndexName = (typeof INDEXES)[keyof typeof INDEXES];
