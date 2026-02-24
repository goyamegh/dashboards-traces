/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple Debug Utility
 *
 * Single source of truth: agent-health.yaml on server
 *
 * Server: Reads/writes agent-health.yaml
 * Browser: Uses localStorage cache (synced via Settings page API calls)
 */

const isBrowser = typeof window !== 'undefined';

// Server-side: persist debug state in agent-health.yaml
let serverDebugEnabled = false;

// Initialize server debug state from agent-health.yaml or env var
if (!isBrowser) {
  try {
    const fs = require('fs');
    const path = require('path');
    const yaml = require('yaml');
    const configPath = path.join(process.cwd(), 'agent-health.yaml');

    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = yaml.parse(content) || {};
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
 * Server: reads from memory (loaded from agent-health.yaml)
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
 * Server: updates memory + persists to agent-health.yaml
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

  // Server-side: update memory + persist to yaml
  serverDebugEnabled = enabled;

  try {
    const fs = require('fs');
    const path = require('path');
    const yaml = require('yaml');
    const configPath = path.join(process.cwd(), 'agent-health.yaml');

    let config: any = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = yaml.parse(content) || {};
    }

    config.debug = enabled;

    fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
    console.info(`[Debug] Debug mode ${enabled ? 'enabled' : 'disabled'}, persisted to agent-health.yaml`);
  } catch (err) {
    console.warn('[Debug] Failed to persist debug state to agent-health.yaml:', err);
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
