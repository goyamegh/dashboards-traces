/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { reindexSingleIndex, fixIndexMappings } from '@/server/services/mappingFixer';
import { acquireMigrationLock, releaseMigrationLock, isMigrationInProgress } from '@/server/services/migrationLock';
import type { ValidationResult } from '@/server/services/mappingValidator';

// Mock index mappings
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'evals_test_cases': {
      mappings: { properties: { id: { type: 'keyword' } } },
    },
    'evals_runs': {
      settings: { 'index.mapping.total_fields.limit': 2000 },
      mappings: { properties: { id: { type: 'keyword' } } },
    },
  },
}));

// Mock migration lock
jest.mock('@/server/services/migrationLock', () => ({
  acquireMigrationLock: jest.fn(),
  releaseMigrationLock: jest.fn(),
  isMigrationInProgress: jest.fn().mockReturnValue(false),
}));

const mockIndicesExists = jest.fn();
const mockIndicesCreate = jest.fn();
const mockIndicesDelete = jest.fn();
const mockIndicesGetSettings = jest.fn();
const mockIndicesRefresh = jest.fn().mockResolvedValue({});
const mockReindex = jest.fn();

const mockClient = {
  indices: {
    exists: mockIndicesExists,
    create: mockIndicesCreate,
    delete: mockIndicesDelete,
    getSettings: mockIndicesGetSettings,
    refresh: mockIndicesRefresh,
  },
  reindex: mockReindex,
} as any;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('reindexSingleIndex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIndicesGetSettings.mockResolvedValue({
      body: {
        'evals_runs': {
          settings: { index: { number_of_shards: '1', number_of_replicas: '1' } },
        },
      },
    });
  });

  it('should reindex successfully: temp created, data moved, original recreated, temp deleted', async () => {
    // No stale temp
    mockIndicesExists.mockResolvedValueOnce({ body: false });
    // Create, delete, and reindex all succeed
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockResolvedValue({ body: { total: 5 } });

    const result = await reindexSingleIndex(mockClient, 'evals_runs');

    expect(result.documentsReindexed).toBe(5);
    // Should create temp + recreate original = 2 creates
    expect(mockIndicesCreate).toHaveBeenCalledTimes(2);
    // Should reindex to temp + reindex back = 2 reindexes
    expect(mockReindex).toHaveBeenCalledTimes(2);
    // Should delete original + delete temp = 2 deletes
    expect(mockIndicesDelete).toHaveBeenCalledTimes(2);
  });

  it('should clean up stale temp index from previous failed attempt', async () => {
    // Stale temp exists
    mockIndicesExists.mockResolvedValueOnce({ body: true });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockResolvedValue({ body: { total: 3 } });

    const result = await reindexSingleIndex(mockClient, 'evals_runs');

    expect(result.documentsReindexed).toBe(3);
    // 3 deletes: stale temp + original + final temp
    expect(mockIndicesDelete).toHaveBeenCalledTimes(3);
  });

  it('should throw for unknown index names', async () => {
    await expect(reindexSingleIndex(mockClient, 'unknown_index')).rejects.toThrow('Unknown index');
  });

  it('should handle reindex failure', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: false });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockRejectedValue(new Error('Reindex timeout'));

    await expect(reindexSingleIndex(mockClient, 'evals_runs')).rejects.toThrow('Reindex timeout');
  });

  it('should handle 0 documents (empty index)', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: false });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockResolvedValue({ body: { total: 0 } });

    const result = await reindexSingleIndex(mockClient, 'evals_runs');

    expect(result.documentsReindexed).toBe(0);
    // Still goes through the full create/delete cycle to fix mappings
    expect(mockIndicesCreate).toHaveBeenCalledTimes(2);
  });

  it('should throw on document count mismatch and preserve temp index', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: false });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    // Move 5 to temp, but only 3 come back
    mockReindex
      .mockResolvedValueOnce({ body: { total: 5 } })
      .mockResolvedValueOnce({ body: { total: 3 } });

    await expect(reindexSingleIndex(mockClient, 'evals_runs')).rejects.toThrow(
      'Document count mismatch during reindex of evals_runs'
    );

    // Temp index should NOT be deleted (only 2 deletes: original index)
    // The error is thrown before the temp delete step
    expect(mockIndicesDelete).toHaveBeenCalledTimes(1);
  });

  it('should throw CRITICAL error with temp index name when recreate fails after delete', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: false }); // no stale temp
    mockIndicesCreate
      .mockResolvedValueOnce({ body: { acknowledged: true } }) // temp create succeeds
      .mockRejectedValueOnce(new Error('Cluster read-only'));   // original recreate fails
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockResolvedValueOnce({ body: { total: 7 } }); // to temp succeeds

    await expect(reindexSingleIndex(mockClient, 'evals_runs')).rejects.toThrow(
      /CRITICAL.*7 docs.*evals_runs_reindex_temp/
    );
  });

  it('should throw CRITICAL error with temp index name when reindex-back fails after delete', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: false }); // no stale temp
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex
      .mockResolvedValueOnce({ body: { total: 12 } })          // to temp succeeds
      .mockRejectedValueOnce(new Error('Reindex timeout'));     // back from temp fails

    await expect(reindexSingleIndex(mockClient, 'evals_runs')).rejects.toThrow(
      /CRITICAL.*12 docs.*evals_runs_reindex_temp/
    );
  });
});

describe('fixIndexMappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIndicesGetSettings.mockResolvedValue({
      body: {
        'evals_test_cases': {
          settings: { index: { number_of_shards: '1', number_of_replicas: '1' } },
        },
        'evals_runs': {
          settings: { index: { number_of_shards: '1', number_of_replicas: '1' } },
        },
      },
    });
  });

  it('should process indexes sequentially and report progress', async () => {
    mockIndicesExists.mockResolvedValue({ body: false }); // No stale temp
    // Also need exists check inside fixIndexMappings for the index itself
    mockIndicesExists
      .mockResolvedValueOnce({ body: true })  // evals_test_cases exists
      .mockResolvedValueOnce({ body: false })  // no stale temp for evals_test_cases
      .mockResolvedValueOnce({ body: true })  // evals_runs exists
      .mockResolvedValueOnce({ body: false }); // no stale temp for evals_runs
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex.mockResolvedValue({ body: { total: 10 } });

    const indexesToFix: ValidationResult[] = [
      {
        indexName: 'evals_test_cases',
        status: 'needs_reindex',
        issues: [{ indexName: 'evals_test_cases', field: 'id', expectedType: 'keyword', actualType: 'text', hasKeywordSubfield: false, fixable: true }],
        documentCount: 5,
      },
      {
        indexName: 'evals_runs',
        status: 'needs_reindex',
        issues: [{ indexName: 'evals_runs', field: 'id', expectedType: 'keyword', actualType: 'text', hasKeywordSubfield: false, fixable: true }],
        documentCount: 15,
      },
    ];

    const progressCalls: any[][] = [];
    const onProgress = jest.fn((progress) => {
      progressCalls.push([...progress]);
    });

    const results = await fixIndexMappings(mockClient, indexesToFix, onProgress);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('completed');

    // Verify migration lock was acquired and released
    expect(acquireMigrationLock).toHaveBeenCalledWith(['evals_test_cases', 'evals_runs']);
    expect(releaseMigrationLock).toHaveBeenCalled();

    // Verify progress was reported
    expect(onProgress).toHaveBeenCalled();
    // First call: all pending
    expect(progressCalls[0].every((p: any) => p.status === 'pending')).toBe(true);
  });

  it('should handle partial failure — one succeeds, one fails', async () => {
    // First index succeeds
    mockIndicesExists
      .mockResolvedValueOnce({ body: true })   // evals_test_cases exists
      .mockResolvedValueOnce({ body: false })   // no stale temp for tc
      .mockResolvedValueOnce({ body: true });   // evals_runs exists
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesDelete.mockResolvedValue({ body: { acknowledged: true } });
    mockReindex
      .mockResolvedValueOnce({ body: { total: 5 } })  // tc: to temp
      .mockResolvedValueOnce({ body: { total: 5 } })  // tc: back from temp
      .mockRejectedValueOnce(new Error('Disk full'));   // runs: fails

    // Need getSettings for evals_runs too
    mockIndicesGetSettings
      .mockResolvedValueOnce({
        body: { 'evals_test_cases': { settings: { index: { number_of_shards: '1', number_of_replicas: '1' } } } },
      })
      .mockResolvedValueOnce({
        body: { 'evals_runs': { settings: { index: { number_of_shards: '1', number_of_replicas: '1' } } } },
      });

    // No stale temp for second index
    mockIndicesExists.mockResolvedValueOnce({ body: false });

    const indexesToFix: ValidationResult[] = [
      {
        indexName: 'evals_test_cases',
        status: 'needs_reindex',
        issues: [],
        documentCount: 5,
      },
      {
        indexName: 'evals_runs',
        status: 'needs_reindex',
        issues: [],
        documentCount: 15,
      },
    ];

    const results = await fixIndexMappings(mockClient, indexesToFix);

    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('failed');
    expect(results[1].error).toBe('Disk full');

    // Lock should still be released even on failure
    expect(releaseMigrationLock).toHaveBeenCalled();
  });

  it('should skip non-existent indexes during fix', async () => {
    // Index doesn't exist anymore
    mockIndicesExists.mockResolvedValueOnce({ body: false });

    const indexesToFix: ValidationResult[] = [
      {
        indexName: 'evals_test_cases',
        status: 'needs_reindex',
        issues: [],
        documentCount: 0,
      },
    ];

    const results = await fixIndexMappings(mockClient, indexesToFix);

    expect(results[0].status).toBe('completed');
    expect(results[0].documentCount).toBe(0);
    expect(releaseMigrationLock).toHaveBeenCalled();
  });

  it('should release migration lock even when reindex throws', async () => {
    mockIndicesExists.mockResolvedValueOnce({ body: true }); // index exists
    mockIndicesGetSettings.mockRejectedValue(new Error('Connection lost'));

    const indexesToFix: ValidationResult[] = [
      {
        indexName: 'evals_test_cases',
        status: 'needs_reindex',
        issues: [],
        documentCount: 10,
      },
    ];

    const results = await fixIndexMappings(mockClient, indexesToFix);

    expect(results[0].status).toBe('failed');
    // Lock must be released
    expect(releaseMigrationLock).toHaveBeenCalled();
  });
});
