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

// Config v2: debug lives in the project runtime state file
// (<cwd>/.agent-health/state.json). In code-first mode (an
// agent-health.config.ts is present) it is in-memory only (DEBUG env still honored).
// Kept fs/path-only here because this module is isomorphic (browser + server);
// statePaths.ts is server-only.
const STATE_DIR = '.agent-health';
const STATE_FILE = 'state.json';
const AUTHORED_CONFIG_NAMES = ['agent-health.config.ts', 'agent-health.config.js', 'agent-health.config.mjs'];

function debugIsCodeFirst(): boolean {
  // Mirror statePaths.isCodeFirstMode: an authored config at project OR user
  // scope (~/.agent-health/) means code-first. os.homedir() is avoided so this
  // isomorphic module stays browser-safe; this path only runs server-side.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return AUTHORED_CONFIG_NAMES.some((n) =>
    fs.existsSync(path.join(process.cwd(), n)) ||
    (!!home && fs.existsSync(path.join(home, STATE_DIR, n)))
  );
}
function debugStatePath(): string {
  return path.join(process.cwd(), STATE_DIR, STATE_FILE);
}

// Server-side: persist debug state in the runtime state file
let serverDebugEnabled = false;

// Initialize server debug state from the state file (ui-first) or env var
if (!isBrowser) {
  try {
    const statePath = debugStatePath();
    if (!debugIsCodeFirst() && fs.existsSync(statePath)) {
      const config = JSON.parse(fs.readFileSync(statePath, 'utf-8')) || {};
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

  // Server-side: update memory + persist to the runtime state file
  serverDebugEnabled = enabled;

  // Code-first mode: the state file is ignored; keep debug in-memory only.
  if (debugIsCodeFirst()) {
    console.info(`[Debug] code-first mode (agent-health.config.ts present): debug ${enabled ? 'enabled' : 'disabled'} in-memory only (not persisted)`);
    return;
  }

  try {
    const dir = path.join(process.cwd(), STATE_DIR);
    const statePath = debugStatePath();

    let config: any = {};
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[Debug] State file contains non-object content, skipping write to avoid clobber`);
        return;
      }
      config = parsed;
    }

    config.debug = enabled;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.info(`[Debug] Debug mode ${enabled ? 'enabled' : 'disabled'}, persisted to ${STATE_DIR}/${STATE_FILE}`);
  } catch (err) {
    console.warn(`[Debug] Failed to persist debug state:`, err);
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
