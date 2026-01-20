/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Express Request Type Extensions
 *
 * Adds storage client properties to the Express Request object.
 * These are populated by the storageClient middleware.
 */

import { Client } from '@opensearch-project/opensearch';
import type { StorageClusterConfig } from '../../types/index.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * OpenSearch client for storage operations.
       * Populated by storageClient middleware.
       * null if storage is not configured.
       */
      storageClient: Client | null;

      /**
       * Storage configuration (endpoint + credentials).
       * Populated by storageClient middleware.
       * null if storage is not configured.
       */
      storageConfig: StorageClusterConfig | null;
    }
  }
}

export {};
