/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migration Lock Service
 *
 * Per-index write lock that prevents concurrent writes while an index is being
 * reindexed to fix incompatible mappings. During reindex the original index is
 * deleted and recreated — concurrent writes would either fail with 404 or
 * auto-create the index with wrong mappings again.
 *
 * The lock is per-index: if only `evals_runs` needs reindex, writes to
 * `evals_test_cases` still work.
 */

let migrationInProgress = false;
const migrationIndexes = new Set<string>();

/**
 * Acquire the migration lock for the given indexes.
 * Called by mappingFixer before starting reindex operations.
 */
export function acquireMigrationLock(indexes: string[]): void {
  migrationInProgress = true;
  for (const index of indexes) {
    migrationIndexes.add(index);
  }
}

/**
 * Release the migration lock for all indexes.
 * Called in a `finally` block after reindex completes (success or failure).
 * Safe to call multiple times (idempotent).
 */
export function releaseMigrationLock(): void {
  migrationInProgress = false;
  migrationIndexes.clear();
}

/**
 * Check if any migration is currently in progress.
 */
export function isMigrationInProgress(): boolean {
  return migrationInProgress;
}

/**
 * Get the set of indexes currently being migrated.
 */
export function getMigrationIndexes(): string[] {
  return Array.from(migrationIndexes);
}

/**
 * Assert that the given index is not currently being migrated.
 * Throws an error if the index is locked, which API routes should catch
 * and return as 503 Service Unavailable.
 *
 * If no indexName is provided, checks if any migration is in progress.
 */
export function assertNotMigrating(indexName?: string): void {
  if (!migrationInProgress) return;

  if (indexName) {
    if (migrationIndexes.has(indexName)) {
      throw new MigrationInProgressError(
        `Index ${indexName} is being migrated. Please wait for migration to complete.`
      );
    }
  } else {
    throw new MigrationInProgressError(
      'A migration is in progress. Please wait for migration to complete.'
    );
  }
}

/**
 * Custom error class for migration lock violations.
 * API routes can check `instanceof MigrationInProgressError` to return 503.
 */
export class MigrationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationInProgressError';
  }
}
