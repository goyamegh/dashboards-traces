/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Migration (config v2, #271)
 *
 * One-time, idempotent migration of legacy on-disk config into the new runtime
 * state file at `<cwd>/.agent-health/state.json`:
 *   - `agent-health.yaml`        → state.json (storage/observability)
 *   - `agent-health.config.json` → state.json (storage/observability/customAgents/debug/remoteServers/codingAgentAnalytics)
 *
 * Each source is renamed to `*.backup` after migration so it runs once.
 * If an authored `agent-health.config.ts` is also present (code-first mode),
 * the migrated storage/observability are IGNORED at runtime — we still migrate
 * them (so nothing is lost) but warn the user to move them into the `.ts`.
 *
 * js-yaml is kept as a dependency only for the YAML path.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  projectStateDir,
  projectStatePath,
  isCodeFirstMode,
  LEGACY_JSON_FILENAME,
} from '@/lib/config/statePaths';

const YAML_FILENAME = 'agent-health.yaml';
const BACKUP_SUFFIX = '.backup';

/** Keys the legacy JSON owned that belong in the runtime state file. */
const STATE_KEYS = ['storage', 'observability', 'customAgents', 'debug', 'remoteServers', 'codingAgentAnalytics'];

function readJsonObject(p: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readProjectState(): Record<string, unknown> {
  const sp = projectStatePath();
  if (!fs.existsSync(sp)) return {};
  return readJsonObject(sp) ?? {};
}

function writeProjectState(obj: Record<string, unknown>): void {
  fs.mkdirSync(projectStateDir(), { recursive: true });
  fs.writeFileSync(projectStatePath(), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

/**
 * Run all one-time config migrations. Call once at server startup, before
 * loading config. Never throws — failures are logged and degrade gracefully.
 */
export async function migrateLegacyConfigIfNeeded(): Promise<void> {
  await migrateYaml();
  migrateLegacyJson();
}

/** Back-compat alias: server/app.ts imports this name. */
export const migrateYamlToJsonIfNeeded = migrateLegacyConfigIfNeeded;

async function migrateYaml(): Promise<void> {
  const yamlPath = path.join(process.cwd(), YAML_FILENAME);
  const backupPath = yamlPath + BACKUP_SUFFIX;
  if (!fs.existsSync(yamlPath) || fs.existsSync(backupPath)) return;

  try {
    const yaml = await import('js-yaml');
    const yamlConfig = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown> | null;
    if (!yamlConfig || typeof yamlConfig !== 'object') {
      console.warn('[ConfigMigration] YAML file is empty or invalid, skipping migration');
      return;
    }
    const state = readProjectState();
    if (yamlConfig.storage) state.storage = yamlConfig.storage;
    if (yamlConfig.observability) state.observability = yamlConfig.observability;
    writeProjectState(state);
    fs.renameSync(yamlPath, backupPath);
    console.log(`[ConfigMigration] Migrated ${YAML_FILENAME} → .agent-health/state.json (backup: ${YAML_FILENAME}${BACKUP_SUFFIX})`);
  } catch (error) {
    console.error('[ConfigMigration] YAML migration failed:', error);
  }
}

function migrateLegacyJson(): void {
  const legacyPath = path.join(process.cwd(), LEGACY_JSON_FILENAME);
  const backupPath = legacyPath + BACKUP_SUFFIX;
  if (!fs.existsSync(legacyPath) || fs.existsSync(backupPath)) return;

  const legacy = readJsonObject(legacyPath);
  if (!legacy) {
    console.warn(`[ConfigMigration] ${LEGACY_JSON_FILENAME} is unreadable/corrupt, skipping migration`);
    return;
  }

  try {
    const state = readProjectState();
    for (const k of STATE_KEYS) {
      if (k in legacy) state[k] = legacy[k];
    }
    writeProjectState(state);
    fs.renameSync(legacyPath, backupPath);
    console.log(`[ConfigMigration] Migrated ${LEGACY_JSON_FILENAME} → .agent-health/state.json (backup: ${LEGACY_JSON_FILENAME}${BACKUP_SUFFIX})`);

    if (isCodeFirstMode() && (legacy.storage || legacy.observability)) {
      console.warn(
        '[ConfigMigration] NOTE: agent-health.config.ts is present (code-first mode), so the migrated ' +
        'storage/observability in .agent-health/state.json are IGNORED. Move them into agent-health.config.ts ' +
        '(see docs/CONFIGURATION.md).',
      );
    }
  } catch (error) {
    console.error('[ConfigMigration] JSON migration failed:', error);
  }
}
