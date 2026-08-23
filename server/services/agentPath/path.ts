/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent path resolver.
 *
 * Resolves the user-supplied "agent path" — the directory containing the
 * agent under evaluation. The judge and AI assistant use this to ground
 * their reasoning in the actual agent's source files.
 *
 * Resolution order:
 *   1. process.env.AH_AGENT_PATH (set by CLI flag --agent-path or by the
 *      user directly).
 *   2. null (feature dormant; no context loaded).
 *
 * The CLI sets AH_AGENT_PATH on process.env before booting the server, so
 * the runtime resolver only needs to look at one source.
 *
 * Opt-in only: never auto-defaults to process.cwd().
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { debug } from '@/lib/debug';

let warnedMissing = false;

/**
 * Resolve the configured agent path. Returns an absolute path when set
 * and valid; returns null otherwise.
 */
export function resolveAgentPath(): string | null {
  const raw = process.env.AH_AGENT_PATH?.trim();
  if (!raw) return null;

  const abs = resolve(raw);

  try {
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      if (!warnedMissing) {
        warnedMissing = true;
        debug('AgentPath', `AH_AGENT_PATH=${abs} is not a directory; ignoring.`);
      }
      return null;
    }
  } catch {
    if (!warnedMissing) {
      warnedMissing = true;
      debug('AgentPath', `AH_AGENT_PATH=${abs} does not exist; ignoring.`);
    }
    return null;
  }

  return abs;
}

/** TEST-ONLY: reset internal warn-once state. */
export function _resetAgentPathWarningForTests(): void {
  warnedMissing = false;
}

/**
 * Convenience: is the feature active right now?
 */
export function isAgentPathConfigured(): boolean {
  return resolveAgentPath() !== null;
}

/**
 * Synchronous existence check so callers can short-circuit before doing
 * any expensive discovery work. Cheaper than full resolveAgentPath().
 */
export function hasAgentPathEnv(): boolean {
  const raw = process.env.AH_AGENT_PATH?.trim();
  if (!raw) return false;
  try {
    return existsSync(resolve(raw));
  } catch {
    return false;
  }
}
