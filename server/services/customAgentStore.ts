/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed store for custom agent endpoints added via the UI.
 * The in-memory Map provides fast reads; every mutation persists to
 * `agent-health.config.json` in the project root.  On module load the
 * Map is hydrated from the file so custom agents survive server restarts.
 *
 * The JSON file uses a `{ "customAgents": [...] }` structure, designed
 * for future expansion (data-source configs, etc. can be added as
 * sibling keys without a migration).
 *
 * Graceful degradation: corrupt / missing files → empty store,
 * write failures are logged but never crash the server.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from '@/types';

/* ------------------------------------------------------------------ */
/*  File helpers                                                       */
/* ------------------------------------------------------------------ */

const CONFIG_FILENAME = 'agent-health.config.json';

function getConfigFilePath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
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
      console.error('[customAgentStore] Config file contains non-object content, refusing to overwrite');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error('[customAgentStore] Failed to read config file:', err);
    return null;
  }
}

/**
 * Extract the `customAgents` array from the on-disk config.
 * Skips entries that lack a `key` property (defensive).
 */
function readCustomAgentsFromDisk(): AgentConfig[] {
  const config = readConfigFromDisk();
  if (config === null) return [];
  const agents = config.customAgents;
  if (!Array.isArray(agents)) return [];
  return agents.filter(
    (a): a is AgentConfig => a !== null && typeof a === 'object' && typeof (a as any).key === 'string',
  );
}

/**
 * Persist the current store to disk.
 * Preserves any sibling top-level keys already in the file.
 * Only writes the file when there is at least one remaining key — never deletes.
 * File lifecycle (create / delete) is the responsibility of configService.ts.
 */
function saveToDisk(): void {
  try {
    const filePath = getConfigFilePath();
    const agents = Array.from(store.values());
    const existing = readConfigFromDisk();

    if (existing === null) {
      console.error('[customAgentStore] Config file is unreadable or corrupt, skipping write to avoid clobber');
      return;
    }

    if (agents.length === 0) {
      delete existing.customAgents;
    } else {
      existing.customAgents = agents;
    }

    if (Object.keys(existing).length > 0) {
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    }
    // If nothing remains, leave the file as-is — file lifecycle is managed by configService.ts
  } catch (err) {
    console.error('[customAgentStore] Failed to write config file:', err);
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
