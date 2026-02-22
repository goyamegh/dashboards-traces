/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Express App Factory
 * Creates and configures the Express application
 */

import express, { Express } from 'express';
import { Client } from '@opensearch-project/opensearch';
import routes from './routes/index.js';
import { setupMiddleware, setupSpaFallback } from './middleware/index.js';
import { loadConfig } from '@/lib/config/index';
import { migrateYamlToJsonIfNeeded } from './services/configMigration.js';
import { getStorageConfigFromFile } from './services/configService.js';
import { getStorageConfigFromEnv } from './middleware/dataSourceConfig.js';
import { setStorageModule } from './adapters/index.js';
import { OpenSearchStorageModule } from './adapters/opensearch/StorageModule.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';

/**
 * Resolve storage config at startup (no request context available).
 * Priority: file config > environment variables > null.
 */
function resolveStorageConfigAtStartup() {
  return getStorageConfigFromFile() ?? getStorageConfigFromEnv() ?? null;
}

/**
 * If OpenSearch storage is configured, create an OpenSearchStorageModule
 * and register it as the active storage backend.
 */
async function initializeStorageBackend(): Promise<void> {
  const config = resolveStorageConfigAtStartup();
  if (!config) return;

  const clientConfig: any = {
    node: config.endpoint,
    ssl: { rejectUnauthorized: !config.tlsSkipVerify },
  };

  if (config.username && config.password) {
    clientConfig.auth = {
      username: config.username,
      password: config.password,
    };
  }

  const client = new Client(clientConfig);

  try {
    // Verify connectivity before swapping the storage module
    await client.cluster.health({ timeout: '5s' });
    const osModule = new OpenSearchStorageModule(client);
    setStorageModule(osModule);
    console.log('[app] OpenSearch storage module activated');
  } catch (error: any) {
    console.warn('[app] OpenSearch not reachable, falling back to file storage:', error.message);
    await client.close().catch(() => {});
  }
}

/**
 * Create and configure the Express application
 * Server loads its own config to ensure the cache is populated in the same
 * module scope as route handlers (fixes CLI-spawned server config isolation).
 * @returns Configured Express app
 */
export async function createApp(): Promise<Express> {
  // Migrate agent-health.yaml → agent-health.config.json if needed (one-time)
  await migrateYamlToJsonIfNeeded();

  await loadConfig();

  // Swap to OpenSearch storage when configured and reachable
  await initializeStorageBackend();

  const app = express();

  // Setup middleware (CORS, JSON parsing, static assets)
  setupMiddleware(app);

  // Setup routes
  app.use(routes);

  // SPA fallback - must be after routes so API requests aren't intercepted
  setupSpaFallback(app);

  return app;
}

export default createApp;
