/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Configuration Resolution
 *
 * Resolves data source configuration from:
 * 1. File (agent-health.config.json) - highest priority
 * 2. Environment variables - fallback
 *
 * NO HEADERS - credentials are never sent from browser for security.
 */

import { Request } from 'express';
import type { StorageClusterConfig, ObservabilityClusterConfig, ObservabilitySourceConfig, ClusterAuthType, ObservabilityBackendType } from '../../types/index.js';
import { DEFAULT_CLOUDWATCH_LOG_GROUPS } from '../../types/index.js';
import {
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
  getStorageConfigFromTs,
  getObservabilityConfigFromTs,
  getObservabilitySourcesFromTs,
  getObservabilitySourcesFromFile,
} from '../services/configService.js';

// Default OTEL index patterns
export const DEFAULT_OTEL_INDEXES = {
  traces: 'otel-v1-apm-span-*',
  logs: 'ml-commons-logs-*',
  metrics: 'otel-v1-apm-service-map*',
} as const;

// Default storage index names (not configurable)
// Note: benchmarks key uses old index name 'evals_experiments' for data compatibility
export const STORAGE_INDEXES = {
  testCases: 'evals_test_cases',
  benchmarks: 'evals_experiments',
  runs: 'evals_runs',
  analytics: 'evals_analytics',
  evaluators: 'evals_evaluators',
} as const;

/**
 * Resolve storage cluster configuration
 *
 * Priority:
 * 1. File config (agent-health.config.json) - UI-writable, highest
 * 2. TypeScript config (agent-health.config.ts via defineConfig)
 * 3. Environment variables (OPENSEARCH_STORAGE_*)
 * 4. null (not configured -> file-based fallback)
 */
export function resolveStorageConfig(req: Request): StorageClusterConfig | null {
  // 1. Check file config first
  const fileConfig = getStorageConfigFromFile();
  if (fileConfig) {
    return fileConfig;
  }

  // 2. TypeScript config (agent-health.config.ts)
  const tsConfig = getStorageConfigFromTs();
  if (tsConfig) {
    return tsConfig;
  }

  // 3. Fall back to environment variables
  const envEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;

  if (envEndpoint) {
    return {
      endpoint: envEndpoint,
      authType: (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || undefined,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
      awsProfile: process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_STORAGE_AWS_REGION,
      awsService: (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined,
      tlsSkipVerify: process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true',
    };
  }

  // Not configured
  return null;
}

/**
 * Resolve observability cluster configuration
 *
 * Priority:
 * 1. File config (agent-health.config.json) - UI-writable, highest
 * 2. TypeScript config (agent-health.config.ts via defineConfig)
 * 3. Environment variables (OPENSEARCH_LOGS_*)
 * 4. null (not configured)
 *
 * Index patterns use defaults if not specified in file, TS, or env vars.
 */
export function resolveObservabilityConfig(req: Request): ObservabilityClusterConfig | null {
  // 1. Check file config first
  const fileConfig = getObservabilityConfigFromFile();
  
  if (fileConfig) return withObservabilityDefaults(fileConfig);

  // 2. TypeScript config (agent-health.config.ts)
  const tsConfig = getObservabilityConfigFromTs();
  if (tsConfig) return withObservabilityDefaults(tsConfig);

  // 3. Fall back to environment variables
  const envConfig = getObservabilityConfigFromEnv();
  if (envConfig) return withObservabilityDefaults(envConfig);

  return null;
}

/**
 * Every observability source to read, in order: the primary (`observability`,
 * resolved as before) first, then the additional `observabilitySources` —
 * TS-authored ones, then state-file ones (code-first mode ignores the state
 * file, exactly as for the primary). Each has defaults applied and a display
 * name (`name` → `id` → "primary").
 */
export function resolveObservabilitySources(req: Request): Array<ObservabilitySourceConfig & { name: string }> {
  const out: Array<ObservabilitySourceConfig & { name: string }> = [];
  const primary = resolveObservabilityConfig(req);
  if (primary) out.push({ ...primary, id: 'primary', name: 'primary' });
  const stateIgnored = !!getObservabilityConfigFromTs() || getObservabilitySourcesFromTs().length > 0;
  const extra = [...getObservabilitySourcesFromTs(), ...(stateIgnored ? [] : getObservabilitySourcesFromFile())];
  for (const src of extra) {
    if (out.some((o) => o.id === src.id)) continue;
    out.push({ ...withObservabilityDefaults(src), id: src.id, name: src.name || src.id });
  }
  return out;
}

/**
 * Fill in backend defaults (index patterns for OpenSearch, log groups for
 * CloudWatch) and drop the fields the other backend does not use.
 */
export function withObservabilityDefaults(config: ObservabilityClusterConfig): ObservabilityClusterConfig {
  const base = {
    authType: config.authType,
    username: config.username,
    password: config.password,
    awsProfile: config.awsProfile,
    awsRegion: config.awsRegion,
    awsService: config.awsService,
    tlsSkipVerify: config.tlsSkipVerify,
  };
  if (config.type === 'cloudwatch') {
    return {
      ...base,
      type: 'cloudwatch',
      logGroups: {
        traces: config.logGroups?.traces || DEFAULT_CLOUDWATCH_LOG_GROUPS.traces,
        logs: config.logGroups?.logs || DEFAULT_CLOUDWATCH_LOG_GROUPS.logs,
      },
    };
  }
  return {
    ...base,
    type: 'opensearch',
    endpoint: config.endpoint,
    indexes: {
      traces: config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
      logs: config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
      metrics: config.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
    },
  };
}

/**
 * Check if storage is configured (either via file or env vars)
 */
export function isStorageConfigured(req: Request): boolean {
  return resolveStorageConfig(req) !== null;
}

/**
 * Check if observability is configured (either via file or env vars)
 */
export function isObservabilityConfigured(req: Request): boolean {
  return resolveObservabilityConfig(req) !== null;
}

/**
 * Get storage config from environment variables only (for backwards compatibility)
 * Used by routes that don't yet support file-based config
 */
export function getStorageConfigFromEnv(): StorageClusterConfig | null {
  const endpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;

  if (!endpoint) {
    return null;
  }

  return {
    endpoint,
    authType: (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || undefined,
    username: process.env.OPENSEARCH_STORAGE_USERNAME,
    password: process.env.OPENSEARCH_STORAGE_PASSWORD,
    awsProfile: process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
    awsRegion: process.env.OPENSEARCH_STORAGE_AWS_REGION,
    awsService: (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined,
    tlsSkipVerify: process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true',
  };
}

/**
 * Get observability config from environment variables only
 * Used by routes that don't yet support file-based config
 */
export function getObservabilityConfigFromEnv(): ObservabilityClusterConfig | null {
  // CloudWatch: OBSERVABILITY_TYPE=cloudwatch + CLOUDWATCH_REGION (profile / log groups optional)
  if ((process.env.OBSERVABILITY_TYPE as ObservabilityBackendType | undefined) === 'cloudwatch') {
    const awsRegion = process.env.CLOUDWATCH_REGION || process.env.AWS_REGION;
    if (!awsRegion) return null;
    return {
      type: 'cloudwatch',
      awsRegion,
      awsProfile: process.env.CLOUDWATCH_AWS_PROFILE,
      logGroups: {
        traces: process.env.CLOUDWATCH_TRACES_LOG_GROUP || DEFAULT_CLOUDWATCH_LOG_GROUPS.traces,
        logs: process.env.CLOUDWATCH_LOGS_LOG_GROUP || DEFAULT_CLOUDWATCH_LOG_GROUPS.logs,
      },
    };
  }

  const endpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;

  if (!endpoint) {
    return null;
  }

  return {
    type: 'opensearch',
    endpoint,
    authType: (process.env.OPENSEARCH_LOGS_AUTH_TYPE as ClusterAuthType) || undefined,
    username: process.env.OPENSEARCH_LOGS_USERNAME,
    password: process.env.OPENSEARCH_LOGS_PASSWORD,
    awsProfile: process.env.OPENSEARCH_LOGS_AWS_PROFILE,
    awsRegion: process.env.OPENSEARCH_LOGS_AWS_REGION,
    awsService: (process.env.OPENSEARCH_LOGS_AWS_SERVICE as 'es' | 'aoss') || undefined,
    tlsSkipVerify: process.env.OPENSEARCH_LOGS_TLS_SKIP_VERIFY === 'true',
    indexes: {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX || DEFAULT_OTEL_INDEXES.traces,
      logs: process.env.OPENSEARCH_LOGS_INDEX || DEFAULT_OTEL_INDEXES.logs,
      metrics: DEFAULT_OTEL_INDEXES.metrics,
    },
  };
}
