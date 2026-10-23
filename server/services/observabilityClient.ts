/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability module factory.
 *
 * Resolves the request's observability config and returns the matching
 * IObservabilityModule:
 *   - no config            → FileObservabilityModule (zero-config default)
 *   - type 'opensearch'    → OpenSearchObservabilityModule (cached Client per config)
 *   - type 'cloudwatch'    → CloudWatchObservabilityModule (cached per region/profile/log groups)
 *
 * Routes and services MUST go through `getObservabilityModule()`; nothing
 * outside the adapters may hold an OpenSearch Client or an AWS SDK client.
 */

import { Request } from 'express';
import { Client } from '@opensearch-project/opensearch';
import { resolveObservabilityConfig, resolveObservabilitySources, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { CompositeObservabilityModule } from '../adapters/observability/CompositeObservabilityModule.js';
import { createOpenSearchClient, configToCacheKey } from './opensearchClientFactory.js';
import { OpenSearchObservabilityModule } from '../adapters/observability/OpenSearchObservabilityModule.js';
import { CloudWatchObservabilityModule } from '../adapters/observability/CloudWatchObservabilityModule.js';
import { FileObservabilityModule } from '../adapters/observability/FileObservabilityModule.js';
import type { IObservabilityModule } from '../adapters/types.js';
import type { ClusterConfig, ObservabilityClusterConfig } from '../../types/index.js';
import { observabilityBackendType } from '../../types/index.js';

interface CachedClient {
  client: Client;
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache.entries()) {
    if (now - entry.lastUsed > CLIENT_TTL_MS) {
      entry.client.close().catch(() => {});
      clientCache.delete(key);
    }
  }
}, 60 * 1000).unref?.();

function getOrCreateClient(config: ClusterConfig): Client {
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

const cloudWatchCache = new Map<string, CloudWatchObservabilityModule>();

export function cloudWatchCacheKey(config: ObservabilityClusterConfig): string {
  return `cloudwatch|${config.awsRegion}|${config.awsProfile || ''}|${config.logGroups?.traces || ''}|${config.logGroups?.logs || ''}`;
}

/** Build a module for an explicit config (Test Connection, tests). Not cached. */
export function createObservabilityModule(config: ObservabilityClusterConfig | null): IObservabilityModule {
  if (!config) return new FileObservabilityModule();
  if (observabilityBackendType(config) === 'cloudwatch') {
    if (!config.awsRegion) throw new Error('observability.awsRegion is required when type is "cloudwatch"');
    return new CloudWatchObservabilityModule({ region: config.awsRegion, profile: config.awsProfile, logGroups: config.logGroups });
  }
  if (!config.endpoint) throw new Error('observability.endpoint is required for the OpenSearch backend');
  const client = createOpenSearchClient(config as ClusterConfig);
  return new OpenSearchObservabilityModule(client, {
    traces: config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
    logs: config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
    metrics: config.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
  });
}

/** Build (cached) the module for one resolved source config. */
function moduleForConfig(config: ObservabilityClusterConfig): IObservabilityModule {
  if (observabilityBackendType(config) === 'cloudwatch') {
    const key = cloudWatchCacheKey(config);
    let mod = cloudWatchCache.get(key);
    if (!mod) {
      mod = createObservabilityModule(config) as CloudWatchObservabilityModule;
      cloudWatchCache.set(key, mod);
    }
    return mod;
  }
  const client = getOrCreateClient(config as ClusterConfig);
  return new OpenSearchObservabilityModule(client, {
    traces: config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
    logs: config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
    metrics: config.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
  });
}

/**
 * The observability module for a request: the file store when nothing is
 * configured, a single backend for one source, or a composite that reads
 * every configured source side by side.
 */
export function getObservabilityModule(req: Request): IObservabilityModule {
  const sources = resolveObservabilitySources(req);
  if (sources.length === 0) {
    return new FileObservabilityModule();
  }
  if (sources.length > 1) {
    return new CompositeObservabilityModule(sources.map((s) => ({ id: s.id, name: s.name, module: moduleForConfig(s) })));
  }
  return moduleForConfig(sources[0]);
}

/** @deprecated kept for callers that only know about the primary source. */
export function getPrimaryObservabilityModule(req: Request): IObservabilityModule {
  const config = resolveObservabilityConfig(req);
  if (!config) {
    return new FileObservabilityModule();
  }

  if (observabilityBackendType(config) === 'cloudwatch') {
    const key = cloudWatchCacheKey(config);
    let mod = cloudWatchCache.get(key);
    if (!mod) {
      mod = createObservabilityModule(config) as CloudWatchObservabilityModule;
      cloudWatchCache.set(key, mod);
    }
    return mod;
  }

  const client = getOrCreateClient(config as ClusterConfig);
  return new OpenSearchObservabilityModule(client, {
    traces: config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
    logs: config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
    metrics: config.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
  });
}

/** Test-only: drop cached backends between cases. */
export function __resetObservabilityCachesForTests(): void {
  for (const e of clientCache.values()) e.client.close().catch(() => {});
  clientCache.clear();
  cloudWatchCache.clear();
}
