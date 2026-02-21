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
import type { StorageClusterConfig, ObservabilityClusterConfig } from '../../types/index.js';

// Same filename used by customAgentStore.ts
const CONFIG_FILENAME = 'agent-health.config.json';

// Type for the config file sections owned by this module
interface ConfigFileDataSources {
  storage?: {
    endpoint: string;
    username?: string;
    password?: string;
    tlsSkipVerify?: boolean;
  };
  observability?: {
    endpoint: string;
    username?: string;
    password?: string;
    tlsSkipVerify?: boolean;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

// Config status returned to frontend (no credentials)
export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;  // Show endpoint for verification, never credentials
  };
  observability: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
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
 * Same pattern as customAgentStore.ts — returns empty object on any error.
 */
function readConfigFromDisk(): Record<string, unknown> {
  try {
    const filePath = getConfigFilePath();
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error('[ConfigService] Failed to read config file:', err);
    return {};
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
  const config = readConfigFromDisk() as ConfigFileDataSources;

  if (!config?.storage?.endpoint) {
    return null;
  }

  return {
    endpoint: config.storage.endpoint,
    username: config.storage.username,
    password: config.storage.password,
    tlsSkipVerify: config.storage.tlsSkipVerify,
  };
}

/**
 * Save storage configuration to file
 */
export function saveStorageConfig(storageConfig: StorageClusterConfig): void {
  const existing = readConfigFromDisk();

  existing.storage = {
    endpoint: storageConfig.endpoint,
    ...(storageConfig.username && { username: storageConfig.username }),
    ...(storageConfig.password && { password: storageConfig.password }),
    ...(storageConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: storageConfig.tlsSkipVerify }),
  };

  writeConfigToDisk(existing);
}

/**
 * Clear storage configuration from file
 */
export function clearStorageConfig(): void {
  const existing = readConfigFromDisk();
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
  const config = readConfigFromDisk() as ConfigFileDataSources;

  if (!config?.observability?.endpoint) {
    return null;
  }

  return {
    endpoint: config.observability.endpoint,
    username: config.observability.username,
    password: config.observability.password,
    tlsSkipVerify: config.observability.tlsSkipVerify,
    indexes: config.observability.indexes,
  };
}

/**
 * Save observability configuration to file
 */
export function saveObservabilityConfig(obsConfig: ObservabilityClusterConfig): void {
  const existing = readConfigFromDisk();

  existing.observability = {
    endpoint: obsConfig.endpoint,
    ...(obsConfig.username && { username: obsConfig.username }),
    ...(obsConfig.password && { password: obsConfig.password }),
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
  const config = readConfigFromDisk() as ConfigFileDataSources;

  // Determine storage config source
  let storageSource: 'file' | 'environment' | 'none' = 'none';
  let storageEndpoint: string | undefined;

  if (config?.storage?.endpoint) {
    storageSource = 'file';
    storageEndpoint = config.storage.endpoint;
  } else if (process.env.OPENSEARCH_STORAGE_ENDPOINT) {
    storageSource = 'environment';
    storageEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
  }

  // Determine observability config source
  let obsSource: 'file' | 'environment' | 'none' = 'none';
  let obsEndpoint: string | undefined;
  let obsIndexes: ConfigStatus['observability']['indexes'];

  if (config?.observability?.endpoint) {
    obsSource = 'file';
    obsEndpoint = config.observability.endpoint;
    obsIndexes = config.observability.indexes;
  } else if (process.env.OPENSEARCH_LOGS_ENDPOINT) {
    obsSource = 'environment';
    obsEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    obsIndexes = {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX,
      logs: process.env.OPENSEARCH_LOGS_INDEX,
    };
  }

  return {
    storage: {
      configured: storageSource !== 'none',
      source: storageSource,
      endpoint: storageEndpoint,
    },
    observability: {
      configured: obsSource !== 'none',
      source: obsSource,
      endpoint: obsEndpoint,
      indexes: obsIndexes,
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
