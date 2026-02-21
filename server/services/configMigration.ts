/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Migration
 *
 * Migrates agent-health.yaml → agent-health.config.json on first startup.
 * After migration, renames YAML to .backup so it only runs once.
 *
 * js-yaml is kept as a dependency only for this migration path.
 * TODO: Remove js-yaml after one release cycle.
 */

import * as fs from 'fs';
import * as path from 'path';

const YAML_FILENAME = 'agent-health.yaml';
const JSON_FILENAME = 'agent-health.config.json';
const BACKUP_SUFFIX = '.backup';

/**
 * Migrate agent-health.yaml to agent-health.config.json if needed.
 * Call this once at server startup, before loading config.
 *
 * No-ops if:
 * - YAML file doesn't exist
 * - YAML .backup already exists (already migrated)
 */
export async function migrateYamlToJsonIfNeeded(): Promise<void> {
  const yamlPath = path.join(process.cwd(), YAML_FILENAME);
  const backupPath = yamlPath + BACKUP_SUFFIX;
  const jsonPath = path.join(process.cwd(), JSON_FILENAME);

  // No YAML file — nothing to migrate
  if (!fs.existsSync(yamlPath)) {
    return;
  }

  // Already migrated — skip
  if (fs.existsSync(backupPath)) {
    return;
  }

  try {
    // Lazy-load js-yaml only when needed (migration only)
    const yaml = await import('js-yaml');

    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
    const yamlConfig = yaml.load(yamlContent) as Record<string, unknown> | null;

    if (!yamlConfig || typeof yamlConfig !== 'object') {
      console.warn('[ConfigMigration] YAML file is empty or invalid, skipping migration');
      return;
    }

    // Read existing JSON config (may have customAgents already)
    let jsonConfig: Record<string, unknown> = {};
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          jsonConfig = parsed;
        }
      } catch {
        // Corrupt JSON — start fresh but preserve nothing
      }
    }

    // Merge YAML sections into JSON (YAML values take priority for storage/observability)
    if (yamlConfig.storage) {
      jsonConfig.storage = yamlConfig.storage;
    }
    if (yamlConfig.observability) {
      jsonConfig.observability = yamlConfig.observability;
    }

    // Write merged JSON
    fs.writeFileSync(jsonPath, JSON.stringify(jsonConfig, null, 2) + '\n', 'utf-8');

    // Rename YAML to .backup
    fs.renameSync(yamlPath, backupPath);

    console.log(`[ConfigMigration] Migrated ${YAML_FILENAME} → ${JSON_FILENAME}`);
    console.log(`[ConfigMigration] Original YAML saved as ${YAML_FILENAME}${BACKUP_SUFFIX}`);
  } catch (error) {
    console.error('[ConfigMigration] Migration failed:', error);
    // Don't crash the server — YAML still exists, configService will fail gracefully
  }
}
