/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple Debug Utility
 *
 * Single source of truth: agent-health.config.json on server
 *
 * Server: Reads/writes agent-health.config.json
 * Browser: Uses localStorage cache (synced via Settings page API calls)
 */

import fs from 'fs';
import path from 'path';

const isBrowser = typeof window !== 'undefined';

const CONFIG_FILENAME = 'agent-health.config.json';

// Server-side: persist debug state in agent-health.config.json
let serverDebugEnabled = false;

// Initialize server debug state from agent-health.config.json or env var
if (!isBrowser) {
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILENAME);

    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content) || {};
      serverDebugEnabled = config.debug === true;
    } else if (process.env?.DEBUG === 'true') {
      serverDebugEnabled = true;
    }
  } catch (err) {
    // Ignore read errors, fall back to env var
    if (process.env?.DEBUG === 'true') {
      serverDebugEnabled = true;
    }
  }
}

/**
 * Check if debug mode is enabled
 * Server: reads from memory (loaded from agent-health.config.json)
 * Browser: reads from localStorage cache (synced by Settings page)
 */
export function isDebugEnabled(): boolean {
  if (isBrowser) {
    try {
      return localStorage.getItem('agenteval_debug') === 'true';
    } catch {
      return false;
    }
  }
  return serverDebugEnabled;
}

/**
 * Set debug state
 * Server: updates memory + persists to agent-health.config.json
 * Browser: updates localStorage cache (Settings page also calls /api/debug)
 */
export function setDebugEnabled(enabled: boolean): void {
  if (isBrowser) {
    try {
      localStorage.setItem('agenteval_debug', String(enabled));
    } catch {
      // Ignore errors (e.g. private browsing)
    }
    return;
  }

  // Server-side: update memory + persist to JSON config
  serverDebugEnabled = enabled;

  try {
    const configPath = path.join(process.cwd(), CONFIG_FILENAME);

    let config: any = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content) || {};
    }

    config.debug = enabled;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.info(`[Debug] Debug mode ${enabled ? 'enabled' : 'disabled'}, persisted to ${CONFIG_FILENAME}`);
  } catch (err) {
    console.warn(`[Debug] Failed to persist debug state to ${CONFIG_FILENAME}:`, err);
  }
}

/**
 * Debug log - only shown when debug mode is enabled
 * Use for verbose/detailed logs that are noisy in normal operation
 */
export function debug(module: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.debug(`[${module}]`, ...args);
  }
}

/**
 * Standard log levels - always available, use appropriately:
 * - console.error() - errors
 * - console.warn() - warnings
 * - console.info() - important milestones (connection established, eval complete)
 * - console.log() - normal operational logs
 * - debug() - verbose details (raw data, classifications, etc.)
 */
