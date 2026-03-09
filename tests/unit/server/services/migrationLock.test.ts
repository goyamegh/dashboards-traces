/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  acquireMigrationLock,
  releaseMigrationLock,
  isMigrationInProgress,
  getMigrationIndexes,
  assertNotMigrating,
  MigrationInProgressError,
} from '@/server/services/migrationLock';

describe('migrationLock', () => {
  afterEach(() => {
    // Always clean up
    releaseMigrationLock();
  });

  describe('acquireMigrationLock / releaseMigrationLock', () => {
    it('should set migration in progress when acquired', () => {
      acquireMigrationLock(['evals_runs']);
      expect(isMigrationInProgress()).toBe(true);
      expect(getMigrationIndexes()).toEqual(['evals_runs']);
    });

    it('should clear migration state when released', () => {
      acquireMigrationLock(['evals_runs', 'evals_test_cases']);
      releaseMigrationLock();
      expect(isMigrationInProgress()).toBe(false);
      expect(getMigrationIndexes()).toEqual([]);
    });

    it('should handle multiple indexes', () => {
      acquireMigrationLock(['evals_runs', 'evals_test_cases']);
      expect(getMigrationIndexes()).toEqual(
        expect.arrayContaining(['evals_runs', 'evals_test_cases'])
      );
    });
  });

  describe('assertNotMigrating', () => {
    it('should not throw when no migration is in progress', () => {
      expect(() => assertNotMigrating()).not.toThrow();
      expect(() => assertNotMigrating('evals_runs')).not.toThrow();
    });

    it('should throw MigrationInProgressError when the specific index is locked', () => {
      acquireMigrationLock(['evals_runs']);

      expect(() => assertNotMigrating('evals_runs')).toThrow(MigrationInProgressError);
      expect(() => assertNotMigrating('evals_runs')).toThrow(
        'Index evals_runs is being migrated. Please wait for migration to complete.'
      );
    });

    it('should NOT throw for an index that is not locked (per-index check)', () => {
      acquireMigrationLock(['evals_runs']);

      // evals_test_cases is NOT locked, only evals_runs
      expect(() => assertNotMigrating('evals_test_cases')).not.toThrow();
    });

    it('should throw for any migration when no indexName is provided', () => {
      acquireMigrationLock(['evals_runs']);

      expect(() => assertNotMigrating()).toThrow(MigrationInProgressError);
    });
  });

  describe('double release (idempotent)', () => {
    it('should be safe to call releaseMigrationLock multiple times', () => {
      acquireMigrationLock(['evals_runs']);
      releaseMigrationLock();
      releaseMigrationLock(); // Should not throw

      expect(isMigrationInProgress()).toBe(false);
      expect(getMigrationIndexes()).toEqual([]);
    });
  });

  describe('MigrationInProgressError', () => {
    it('should have correct name and message', () => {
      const error = new MigrationInProgressError('test message');
      expect(error.name).toBe('MigrationInProgressError');
      expect(error.message).toBe('test message');
      expect(error instanceof Error).toBe(true);
    });
  });
});
