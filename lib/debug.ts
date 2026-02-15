/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple Debug Utility
 * Uses standard console levels with a verbose toggle.
 * Works in both browser (localStorage) and Node.js (in-memory flag / env var).
 */

const isBrowser = typeof window !== 'undefined';

// Server-side in-memory flag, initialized from process.env.DEBUG
let serverDebugEnabled =
  !isBrowser && typeof process !== 'undefined' && process.env?.DEBUG === 'true';

// Check localStorage for debug setting, default to false
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

export function setDebugEnabled(enabled: boolean): void {
  if (isBrowser) {
    try {
      localStorage.setItem('agenteval_debug', String(enabled));
    } catch {
      // Ignore errors (e.g. private browsing)
    }
  } else {
    serverDebugEnabled = enabled;
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
