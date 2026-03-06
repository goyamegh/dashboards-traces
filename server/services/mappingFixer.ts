/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mapping Fixer Service
 *
 * Reindexes OpenSearch indexes to fix incompatible field mappings.
 * Extracted from the inline reindex logic in admin.ts for reuse by both
 * the manual `/api/storage/reindex` route and the automatic fix flow in
 * `ensureIndexesWithValidation()`.
 *
 * Algorithm per index:
 * 1. Create temp index with correct mappings
 * 2. Reindex data: original → temp
 * 3. Delete original
 * 4. Recreate original with correct mappings
 * 5. Reindex data: temp → original
 * 6. Delete temp
 */

import { Client } from '@opensearch-project/opensearch';
import { INDEX_MAPPINGS } from '../constants/indexMappings';
import { debug } from '@/lib/debug';
import { acquireMigrationLock, releaseMigrationLock } from './migrationLock';
import type { ValidationResult } from './mappingValidator';

// ============================================================================
// Types
// ============================================================================

export interface FixProgress {
  indexName: string;
  status: 'pending' | 'reindexing' | 'completed' | 'failed';
  documentCount?: number;
  error?: string;
}

// ============================================================================
// Single-Index Reindex
// ============================================================================

/**
 * Reindex a single index to apply correct mappings.
 * Returns the number of documents reindexed.
 */
export async function reindexSingleIndex(
  client: Client,
  indexName: string
): Promise<{ documentsReindexed: number }> {
  const mapping = INDEX_MAPPINGS[indexName];
  if (!mapping) {
    throw new Error(`Unknown index: ${indexName}. Must be one of: ${Object.keys(INDEX_MAPPINGS).join(', ')}`);
  }

  const tempIndex = `${indexName}_reindex_temp`;

  // Read existing index settings to preserve shard/replica configuration
  const existingSettings = await client.indices.getSettings({ index: indexName });
  const indexSettings = existingSettings.body?.[indexName]?.settings?.index ?? {};
  const preservedSettings: Record<string, any> = {};
  if (indexSettings.number_of_shards) {
    preservedSettings.number_of_shards = Number(indexSettings.number_of_shards);
  }
  if (indexSettings.number_of_replicas) {
    preservedSettings.number_of_replicas = Number(indexSettings.number_of_replicas);
  }

  // Merge: preserved cluster settings + our field limit + our mappings
  const reindexMapping = {
    settings: {
      ...preservedSettings,
      ...(mapping.settings?.['index.mapping.total_fields.limit'] != null
        ? { 'index.mapping.total_fields.limit': mapping.settings['index.mapping.total_fields.limit'] }
        : {}),
    },
    mappings: mapping.mappings,
  };

  // Delete temp index if it exists from a previous failed attempt
  const tempExists = await client.indices.exists({ index: tempIndex });
  if (tempExists.body) {
    await client.indices.delete({ index: tempIndex });
    debug('MappingFixer', `Deleted stale temp index: ${tempIndex}`);
  }

  // Create temp index with correct mappings and preserved settings
  await client.indices.create({ index: tempIndex, body: reindexMapping as any });
  debug('MappingFixer', `Created temp index: ${tempIndex}`);

  // Reindex data from source to temp
  const reindexToTemp = await client.reindex({
    body: {
      source: { index: indexName },
      dest: { index: tempIndex },
    },
    wait_for_completion: true,
    timeout: '5m',
  });
  const docsMovedToTemp = (reindexToTemp.body as any)?.total ?? 0;
  debug('MappingFixer', `Reindexed ${docsMovedToTemp} docs from ${indexName} to ${tempIndex}`);

  // Refresh temp index so docs are visible to the scroll query in the next reindex
  await client.indices.refresh({ index: tempIndex });

  // Delete the original index
  await client.indices.delete({ index: indexName });
  debug('MappingFixer', `Deleted original index: ${indexName}`);

  // Recreate original index with correct mappings and preserved settings
  await client.indices.create({ index: indexName, body: reindexMapping as any });
  debug('MappingFixer', `Recreated index: ${indexName}`);

  // Reindex data back from temp to original
  const reindexBack = await client.reindex({
    body: {
      source: { index: tempIndex },
      dest: { index: indexName },
    },
    wait_for_completion: true,
    timeout: '5m',
  });
  const docsMovedBack = (reindexBack.body as any)?.total ?? 0;
  debug('MappingFixer', `Reindexed ${docsMovedBack} docs from ${tempIndex} to ${indexName}`);

  // Validate document counts match — detect data loss before deleting temp
  if (docsMovedBack !== docsMovedToTemp) {
    throw new Error(
      `Document count mismatch during reindex of ${indexName}: ` +
      `moved ${docsMovedToTemp} docs to temp, but only ${docsMovedBack} came back. ` +
      `Temp index ${tempIndex} preserved for manual recovery.`
    );
  }

  // Delete temp index
  await client.indices.delete({ index: tempIndex });
  debug('MappingFixer', `Deleted temp index: ${tempIndex}`);

  return { documentsReindexed: docsMovedBack };
}

// ============================================================================
// Batch Fix with Progress
// ============================================================================

/**
 * Fix all indexes that need reindexing, processing them sequentially.
 * Acquires a per-index migration lock to prevent concurrent writes.
 */
export async function fixIndexMappings(
  client: Client,
  indexesToFix: ValidationResult[],
  onProgress?: (progress: FixProgress[]) => void
): Promise<FixProgress[]> {
  const indexNames = indexesToFix.map((v) => v.indexName);

  // Initialize progress for all indexes
  const progress: FixProgress[] = indexesToFix.map((v) => ({
    indexName: v.indexName,
    status: 'pending' as const,
    documentCount: v.documentCount,
  }));

  onProgress?.(progress);

  // Acquire migration lock for all indexes being fixed
  acquireMigrationLock(indexNames);

  try {
    // Process indexes sequentially to avoid overloading the cluster
    for (let i = 0; i < indexesToFix.length; i++) {
      const validation = indexesToFix[i];
      progress[i] = { ...progress[i], status: 'reindexing' };
      onProgress?.([...progress]);

      try {
        // Check that the index exists before attempting reindex
        const exists = await client.indices.exists({ index: validation.indexName });
        if (!exists.body) {
          progress[i] = {
            ...progress[i],
            status: 'completed',
            documentCount: 0,
          };
          onProgress?.([...progress]);
          continue;
        }

        const result = await reindexSingleIndex(client, validation.indexName);
        progress[i] = {
          ...progress[i],
          status: 'completed',
          documentCount: result.documentsReindexed,
        };
      } catch (error: any) {
        console.error(`[MappingFixer] Failed to reindex ${validation.indexName}:`, error.message);
        progress[i] = {
          ...progress[i],
          status: 'failed',
          error: error.message,
        };
      }

      onProgress?.([...progress]);
    }
  } finally {
    releaseMigrationLock();
  }

  return progress;
}
