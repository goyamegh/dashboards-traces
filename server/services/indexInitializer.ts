/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Index Initializer Service
 *
 * Ensures all required OpenSearch indexes exist with correct mappings.
 * Used during startup (app.ts) and when attaching a new cluster (admin route).
 */

import { Client } from '@opensearch-project/opensearch';
import { INDEX_MAPPINGS } from '../constants/indexMappings';
import { debug } from '@/lib/debug';
import { validateIndexMappings, type ValidationResult } from './mappingValidator';
import { fixIndexMappings, type FixProgress } from './mappingFixer';

export interface IndexInitResult {
  status: 'created' | 'exists' | 'error';
  settingsUpdated?: boolean;
  mappingsUpdated?: boolean;
  warnings?: string[];
  error?: string;
}

/**
 * Update settings and mappings on an existing index.
 * Both operations are best-effort — failures are returned as warnings.
 */
async function updateExistingIndex(
  client: Client,
  indexName: string,
  mapping: { settings?: Record<string, any>; mappings?: Record<string, any> }
): Promise<{ settingsUpdated?: boolean; mappingsUpdated?: boolean; warnings?: string[] }> {
  const warnings: string[] = [];
  let settingsUpdated = false;
  let mappingsUpdated = false;

  // Update settings (e.g., field limit)
  if (mapping.settings) {
    try {
      const dynamicSettings: Record<string, any> = {};
      if (mapping.settings['index.mapping.total_fields.limit'] != null) {
        dynamicSettings['mapping.total_fields.limit'] = mapping.settings['index.mapping.total_fields.limit'];
      }
      if (Object.keys(dynamicSettings).length > 0) {
        await client.indices.putSettings({ index: indexName, body: { index: dynamicSettings } });
        settingsUpdated = true;
        debug('IndexInitializer', `Updated settings for index: ${indexName}`);
      }
    } catch (error: any) {
      warnings.push(`Failed to update settings: ${error.message}`);
      debug('IndexInitializer', `Failed to update settings for ${indexName}: ${error.message}`);
    }
  }

  // Update mappings (add new field definitions)
  if (mapping.mappings) {
    try {
      await client.indices.putMapping({ index: indexName, body: mapping.mappings });
      mappingsUpdated = true;
      debug('IndexInitializer', `Updated mappings for index: ${indexName}`);
    } catch (error: any) {
      warnings.push(`Failed to update mappings: ${error.message}`);
      debug('IndexInitializer', `Failed to update mappings for ${indexName}: ${error.message}`);
    }
  }

  return {
    ...(settingsUpdated ? { settingsUpdated } : {}),
    ...(mappingsUpdated ? { mappingsUpdated } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Ensure all required indexes exist with correct mappings.
 * Creates missing indexes and updates settings/mappings on existing ones.
 * Individual index failures are captured in the results — this function does not throw.
 */
export async function ensureIndexes(client: Client): Promise<Record<string, IndexInitResult>> {
  const results: Record<string, IndexInitResult> = {};

  for (const [indexName, mapping] of Object.entries(INDEX_MAPPINGS)) {
    try {
      const exists = await client.indices.exists({ index: indexName });
      if (exists.body) {
        const updateResult = await updateExistingIndex(client, indexName, mapping);
        results[indexName] = { status: 'exists', ...updateResult };
        continue;
      }

      await client.indices.create({ index: indexName, body: mapping as any });
      results[indexName] = { status: 'created' };
      debug('IndexInitializer', `Created index: ${indexName}`);
    } catch (error: any) {
      results[indexName] = { status: 'error', error: error.message };
      console.error(`[IndexInitializer] Failed to create index ${indexName}:`, error.message);
    }
  }

  return results;
}

// ============================================================================
// Enhanced Initialization with Validation + Auto-Fix
// ============================================================================

export interface IndexSetupResult {
  indexResults: Record<string, IndexInitResult>;
  validationResults: ValidationResult[];
  fixResults?: FixProgress[];
}

/**
 * Ensure indexes exist, validate mappings, and auto-fix incompatibilities.
 *
 * Flow:
 * 1. Call ensureIndexes() — creates missing indexes, adds new fields to existing ones
 * 2. Call validateIndexMappings() — check for incompatible field types (e.g. text vs keyword)
 * 3. If any index has incompatible mappings, reindex to fix them
 *
 * The onFixProgress callback is called with per-index progress during the fix phase,
 * enabling SSE streaming to the UI or console logging on startup.
 */
export async function ensureIndexesWithValidation(
  client: Client,
  onFixProgress?: (progress: FixProgress[]) => void
): Promise<IndexSetupResult> {
  // Step 1: Create missing indexes, update settings/mappings on existing
  const indexResults = await ensureIndexes(client);

  // Step 2: Validate actual mappings against expected types
  const validationResults = await validateIndexMappings(client);

  // Step 3: Fix incompatible mappings if needed
  const indexesNeedingFix = validationResults.filter((r) => r.status === 'needs_reindex');

  if (indexesNeedingFix.length === 0) {
    debug('IndexInitializer', 'All index mappings are compatible');
    return { indexResults, validationResults };
  }

  const fieldSummary = indexesNeedingFix
    .map((v) => `${v.indexName} (fields: ${v.issues.map((i) => i.field).join(', ')})`)
    .join('; ');
  console.log(`[IndexInitializer] Incompatible mappings detected for: ${fieldSummary}. Auto-fixing...`);

  const fixResults = await fixIndexMappings(client, indexesNeedingFix, onFixProgress);

  const failed = fixResults.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(
      `[IndexInitializer] Failed to fix ${failed.length} index(es): ${failed.map((f) => f.indexName).join(', ')}`
    );
  } else {
    console.log('[IndexInitializer] All indexes fixed successfully');
  }

  return { indexResults, validationResults, fixResults };
}
