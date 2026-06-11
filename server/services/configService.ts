/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Service
 *
 * Manages server-side configuration stored in agent-health.config.json.
 * Provides secure credential storage without browser exposure.
 *
 * Shares the same JSON file as customAgentStore.ts — each module
 * owns its own top-level keys (storage, observability vs customAgents).
 * Safe because Node.js is single-threaded and both use synchronous fs calls.
 */

import fs from 'fs';
import path from 'path';
import { debug } from '../../lib/debug.js';
import { getStorageState, type StorageBackend } from '../adapters/index.js';
import { configToCacheKey } from './opensearchClientFactory.js';
import type { StorageClusterConfig, ObservabilityClusterConfig, ClusterAuthType } from '../../types/index.js';

// Same filename used by customAgentStore.ts
const CONFIG_FILENAME = 'agent-health.config.json';

// Type for the config file sections owned by this module
interface ConfigFileDataSources {
  storage?: {
    endpoint: string;
    authType?: ClusterAuthType;
    username?: string;
    password?: string;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    tlsSkipVerify?: boolean;
  };
  observability?: {
    endpoint: string;
    authType?: ClusterAuthType;
    username?: string;
    password?: string;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    tlsSkipVerify?: boolean;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

// Config status returned to frontend (no raw credentials — username is safe to expose,
// password is indicated only as a boolean so the UI can show placeholder dots)
/**
 * Where a resolved data-source config came from.
 * - 'file'        : agent-health.config.json (UI-writable, highest precedence)
 * - 'typescript'  : agent-health.config.ts via defineConfig() (committed default)
 * - 'environment' : OPENSEARCH_* env vars
 * - 'none'        : not configured (file-based fallback)
 */
export type ConfigSource = 'file' | 'typescript' | 'environment' | 'none';

export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: ConfigSource;
    endpoint?: string;
    authType?: ClusterAuthType;
    username?: string;    // Safe to return; lets the form pre-fill the username
    hasPassword?: boolean; // True when a password is stored; never return the value itself
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
  };
  observability: {
    configured: boolean;
    source: ConfigSource;
    endpoint?: string;
    authType?: ClusterAuthType;
    username?: string;
    hasPassword?: boolean;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
  runtime?: {
    storage: {
      backend: StorageBackend;
      error: string | null;
      configuredEndpoint: string | null;
      drifted: boolean;
    };
  };
}

// ============================================================================
// TypeScript config bridge (agent-health.config.ts -> server)
// ============================================================================
//
// The CLI-launched server loads the user's agent-health.config.ts in-process
// (server/app.ts -> loadConfig()). Storage / observability cluster config
// authored there is handed to this module via setTsClusterConfig() so the
// runtime resolution chain can consult it. This is the "single TS source of
// truth" path requested in #261.
//
// Precedence (highest wins): agent-health.config.json (UI-written) ->
// agent-health.config.ts -> OPENSEARCH_* env -> file-based fallback.

let tsStorageConfig: StorageClusterConfig | null = null;
let tsObservabilityConfig: ObservabilityClusterConfig | null = null;

/**
 * Register cluster config authored in agent-health.config.ts.
 * Called once at server startup with the in-process resolved TS config.
 * Pass `null`/omit a field to leave it unset; an endpoint-less object is
 * treated as "not configured".
 */
export function setTsClusterConfig(opts: {
  storage?: StorageClusterConfig | null;
  observability?: ObservabilityClusterConfig | null;
}): void {
  if (opts.storage !== undefined) {
    tsStorageConfig = opts.storage && opts.storage.endpoint ? opts.storage : null;
  }
  if (opts.observability !== undefined) {
    tsObservabilityConfig = opts.observability && opts.observability.endpoint ? opts.observability : null;
  }
}

/** Storage cluster config authored in agent-health.config.ts, or null. */
export function getStorageConfigFromTs(): StorageClusterConfig | null {
  return tsStorageConfig;
}

/** Observability cluster config authored in agent-health.config.ts, or null. */
export function getObservabilityConfigFromTs(): ObservabilityClusterConfig | null {
  return tsObservabilityConfig;
}

/** Test-only: reset the TS config holder between cases. */
export function __resetTsClusterConfigForTests(): void {
  tsStorageConfig = null;
  tsObservabilityConfig = null;
}

/**
 * Get the config file path.
 * Checks CWD first, then falls back to CWD as default write location.
 */
function getConfigFilePath(): string {
  const cwdPath = path.join(process.cwd(), CONFIG_FILENAME);
  return cwdPath;
}

/**
 * Read the full JSON config from disk.
 * Returns `{}` when file doesn't exist (safe to create new).
 * Returns `null` when file exists but read/parse fails (unsafe to write — would clobber).
 */
function readConfigFromDisk(): Record<string, unknown> | null {
  try {
    const filePath = getConfigFilePath();
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[ConfigService] Config file contains non-object content, refusing to overwrite');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error('[ConfigService] Failed to read config file:', err);
    return null;
  }
}

/**
 * Write config back to disk, preserving all sibling keys.
 * Same pattern as customAgentStore.ts.
 */
function writeConfigToDisk(config: Record<string, unknown>): void {
  try {
    const filePath = getConfigFilePath();
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    debug('ConfigService', `Config saved to ${filePath}`);
  } catch (error) {
    console.error('[ConfigService] Failed to write config file:', error);
    throw error;
  }
}

// ============================================================================
// Storage Configuration
// ============================================================================

/**
 * Get storage configuration from file
 * Returns null if not configured in file
 */
export function getStorageConfigFromFile(): StorageClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

  if (!config?.storage?.endpoint) {
    return null;
  }

  return {
    endpoint: config.storage.endpoint,
    authType: config.storage.authType,
    username: config.storage.username,
    password: config.storage.password,
    awsProfile: config.storage.awsProfile,
    awsRegion: config.storage.awsRegion,
    awsService: config.storage.awsService,
    tlsSkipVerify: config.storage.tlsSkipVerify,
  };
}

/**
 * Save storage configuration to file
 */
export function saveStorageConfig(storageConfig: StorageClusterConfig): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot save storage config: existing config file is unreadable or corrupt');
  }
  const existingStorage = (existing.storage as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored. The form converts sentinel and empty values
  // to undefined before sending. Note: if called directly with password: "",
  // the empty string passes through ?? but is omitted by the falsy spread
  // below, effectively clearing the stored credential. This is intentional.
  const resolvedUsername = storageConfig.username ?? existingStorage.username;
  const resolvedPassword = storageConfig.password ?? existingStorage.password;

  existing.storage = {
    endpoint: storageConfig.endpoint,
    ...(storageConfig.authType && { authType: storageConfig.authType }),
    ...(resolvedUsername && { username: resolvedUsername }),
    ...(resolvedPassword && { password: resolvedPassword }),
    ...(storageConfig.awsProfile && { awsProfile: storageConfig.awsProfile }),
    ...(storageConfig.awsRegion && { awsRegion: storageConfig.awsRegion }),
    ...(storageConfig.awsService && { awsService: storageConfig.awsService }),
    ...(storageConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: storageConfig.tlsSkipVerify }),
  };

  writeConfigToDisk(existing);
}

/**
 * Clear storage configuration from file
 */
export function clearStorageConfig(): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot clear storage config: existing config file is unreadable or corrupt');
  }
  delete existing.storage;

  // If config is now empty, delete the file
  if (Object.keys(existing).length === 0) {
    const filePath = getConfigFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debug('ConfigService', 'Config file deleted (empty)');
    }
  } else {
    writeConfigToDisk(existing);
  }
}

// ============================================================================
// Observability Configuration
// ============================================================================

/**
 * Get observability configuration from file
 * Returns null if not configured in file
 */
export function getObservabilityConfigFromFile(): ObservabilityClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

  if (!config?.observability?.endpoint) {
    return null;
  }

  return {
    endpoint: config.observability.endpoint,
    authType: config.observability.authType,
    username: config.observability.username,
    password: config.observability.password,
    awsProfile: config.observability.awsProfile,
    awsRegion: config.observability.awsRegion,
    awsService: config.observability.awsService,
    tlsSkipVerify: config.observability.tlsSkipVerify,
    indexes: config.observability.indexes,
  };
}

/**
 * Save observability configuration to file
 */
export function saveObservabilityConfig(obsConfig: ObservabilityClusterConfig): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot save observability config: existing config file is unreadable or corrupt');
  }
  const existingObs = (existing.observability as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored.
  const resolvedUsername = obsConfig.username ?? existingObs.username;
  const resolvedPassword = obsConfig.password ?? existingObs.password;

  existing.observability = {
    endpoint: obsConfig.endpoint,
    ...(obsConfig.authType && { authType: obsConfig.authType }),
    ...(resolvedUsername && { username: resolvedUsername }),
    ...(resolvedPassword && { password: resolvedPassword }),
    ...(obsConfig.awsProfile && { awsProfile: obsConfig.awsProfile }),
    ...(obsConfig.awsRegion && { awsRegion: obsConfig.awsRegion }),
    ...(obsConfig.awsService && { awsService: obsConfig.awsService }),
    ...(obsConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: obsConfig.tlsSkipVerify }),
    ...(obsConfig.indexes && Object.keys(obsConfig.indexes).length > 0 && {
      indexes: obsConfig.indexes,
    }),
  };

  writeConfigToDisk(existing);
}

/**
 * Clear observability configuration from file
 */
export function clearObservabilityConfig(): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot clear observability config: existing config file is unreadable or corrupt');
  }
  delete existing.observability;

  // If config is now empty, delete the file
  if (Object.keys(existing).length === 0) {
    const filePath = getConfigFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debug('ConfigService', 'Config file deleted (empty)');
    }
  } else {
    writeConfigToDisk(existing);
  }
}

// ============================================================================
// Config Status (for frontend display)
// ============================================================================

/**
 * Get configuration status for frontend display
 * Never exposes credentials - only shows source and endpoint
 */
export function getConfigStatus(): ConfigStatus {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

  // Resolve the active storage config + source (precedence: file > ts > env).
  let storageSource: ConfigSource = 'none';
  let activeStorage: Partial<StorageClusterConfig> = {};
  if (config?.storage?.endpoint) {
    storageSource = 'file';
    activeStorage = config.storage;
  } else if (tsStorageConfig?.endpoint) {
    storageSource = 'typescript';
    activeStorage = tsStorageConfig;
  } else if (process.env.OPENSEARCH_STORAGE_ENDPOINT) {
    storageSource = 'environment';
    activeStorage = {
      endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT,
      authType: (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || undefined,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
      awsProfile: process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_STORAGE_AWS_REGION,
      awsService: (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined,
    };
  }

  // Resolve the active observability config + source (precedence: file > ts > env).
  let obsSource: ConfigSource = 'none';
  let activeObs: Partial<ObservabilityClusterConfig> = {};
  let obsIndexes: ConfigStatus['observability']['indexes'];
  if (config?.observability?.endpoint) {
    obsSource = 'file';
    activeObs = config.observability;
    obsIndexes = config.observability.indexes;
  } else if (tsObservabilityConfig?.endpoint) {
    obsSource = 'typescript';
    activeObs = tsObservabilityConfig;
    obsIndexes = tsObservabilityConfig.indexes;
  } else if (process.env.OPENSEARCH_LOGS_ENDPOINT) {
    obsSource = 'environment';
    activeObs = {
      endpoint: process.env.OPENSEARCH_LOGS_ENDPOINT,
      authType: (process.env.OPENSEARCH_LOGS_AUTH_TYPE as ClusterAuthType) || undefined,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      awsProfile: process.env.OPENSEARCH_LOGS_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_LOGS_AWS_REGION,
      awsService: (process.env.OPENSEARCH_LOGS_AWS_SERVICE as 'es' | 'aoss') || undefined,
    };
    obsIndexes = {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX,
      logs: process.env.OPENSEARCH_LOGS_INDEX,
    };
  }

  // Compute runtime storage state. Mirror the resolution precedence so drift
  // detection compares against whatever config the storage backend will use.
  const storageState = getStorageState();
  const resolvedStorageConfig = getStorageConfigFromFile() ?? getStorageConfigFromTs() ??
    (process.env.OPENSEARCH_STORAGE_ENDPOINT ? { endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT } as StorageClusterConfig : null);
  const fileConfigKey = resolvedStorageConfig ? configToCacheKey(resolvedStorageConfig) : null;
  const drifted = fileConfigKey !== storageState.configKey &&
    storageState.configKey !== '__file_override__';

  return {
    storage: {
      configured: storageSource !== 'none',
      source: storageSource,
      endpoint: activeStorage.endpoint,
      authType: activeStorage.authType,
      username: activeStorage.username,
      hasPassword: Boolean(activeStorage.password),
      awsProfile: activeStorage.awsProfile,
      awsRegion: activeStorage.awsRegion,
      awsService: activeStorage.awsService,
    },
    observability: {
      configured: obsSource !== 'none',
      source: obsSource,
      endpoint: activeObs.endpoint,
      authType: activeObs.authType,
      username: activeObs.username,
      hasPassword: Boolean(activeObs.password),
      awsProfile: activeObs.awsProfile,
      awsRegion: activeObs.awsRegion,
      awsService: activeObs.awsService,
      indexes: obsIndexes,
    },
    runtime: {
      storage: {
        backend: storageState.backend,
        error: storageState.error,
        configuredEndpoint: storageState.configuredEndpoint,
        drifted,
      },
    },
  };
}

/**
 * Check if config file exists
 */
export function configFileExists(): boolean {
  const filePath = getConfigFilePath();
  return fs.existsSync(filePath);
}
