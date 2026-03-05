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
