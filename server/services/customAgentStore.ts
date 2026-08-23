/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed store for custom agent endpoints added via the UI.
 * The in-memory Map provides fast reads; every mutation persists to
 * `.agent-health/state.json` (runtime state) in ui-first mode. On module load
 * the Map is hydrated from that state so custom agents survive server restarts.
 *
 * The state file uses a `{ "customAgents": [...] }` structure alongside sibling
 * keys (storage, observability, debug, remoteServers). In code-first mode
 * (an agent-health.config.ts exists) the state file is ignored and UI-added
 * agents are not persisted — manage agents in the .ts.
 *
 * Graceful degradation: corrupt / missing files → empty store,
 * write failures are logged but never crash the server.
 */

import type { AgentConfig } from '@/types';
import { readLayeredState, writeStateScope, isCodeFirstMode } from '@/lib/config/statePaths';

/* ------------------------------------------------------------------ */
/*  File helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract the `customAgents` array from layered runtime state.
 * Returns [] in code-first mode (state ignored — agents come from the .ts).
 */
function readCustomAgentsFromDisk(): AgentConfig[] {
  const agents = readLayeredState().customAgents;
  if (!Array.isArray(agents)) return [];
  return agents.filter(
    (a): a is AgentConfig => a !== null && typeof a === 'object' && typeof (a as any).key === 'string',
  );
}

/**
 * Persist the in-memory store to the project runtime state file, preserving
 * sibling keys. No-op (with warning) in code-first mode — custom agents are
 * managed in agent-health.config.ts there.
 */
function saveToDisk(): void {
  if (isCodeFirstMode()) {
    console.warn('[customAgentStore] code-first mode (agent-health.config.ts present): UI-added agents are not persisted; manage them in the config file.');
    return;
  }
  try {
    const agents = Array.from(store.values());
    writeStateScope({ customAgents: agents.length === 0 ? undefined : agents }, 'project');
  } catch (err) {
    console.error('[customAgentStore] Failed to write runtime state:', err);
  }
}

/**
 * Hydrate the in-memory store from the on-disk config.
 * Called once on module load; exported for testing.
 */
export function loadFromDisk(): void {
  const agents = readCustomAgentsFromDisk();
  for (const agent of agents) {
    store.set(agent.key, { ...agent, isCustom: true });
  }
}

/* ------------------------------------------------------------------ */
/*  In-memory store                                                    */
/* ------------------------------------------------------------------ */

const store = new Map<string, AgentConfig>();

// Hydrate on module load
loadFromDisk();

/* ------------------------------------------------------------------ */
/*  Public API (unchanged)                                             */
/* ------------------------------------------------------------------ */

/**
 * Add a custom agent to the store.
 * The agent will have `isCustom: true` set automatically.
 */
export function addCustomAgent(agent: AgentConfig): void {
  store.set(agent.key, { ...agent, isCustom: true });
  saveToDisk();
}

/**
 * Remove a custom agent by its key.
 * @returns true if the agent was found and removed, false otherwise.
 */
export function removeCustomAgent(key: string): boolean {
  const deleted = store.delete(key);
  if (deleted) saveToDisk();
  return deleted;
}

/**
 * Get all custom agents.
 */
export function getCustomAgents(): AgentConfig[] {
  return Array.from(store.values());
}

/**
 * Clear all custom agents.
 */
export function clearCustomAgents(): void {
  store.clear();
  saveToDisk();
}
