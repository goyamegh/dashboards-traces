/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ensureIndexes, ensureIndexesWithValidation } from '@/server/services/indexInitializer';
import { validateIndexMappings } from '@/server/services/mappingValidator';
import { fixIndexMappings } from '@/server/services/mappingFixer';

// Mock index mappings
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'evals_test_cases': { mappings: { properties: { id: { type: 'keyword' } } } },
    'evals_experiments': {
      settings: { 'index.mapping.total_fields.limit': 5000 },
      mappings: { properties: { id: { type: 'keyword' }, runs: { type: 'nested' } } },
    },
    'evals_runs': {
      settings: { 'index.mapping.total_fields.limit': 2000 },
      mappings: { properties: { id: { type: 'keyword' } } },
    },
    'evals_analytics': { mappings: { properties: { analyticsId: { type: 'keyword' } } } },
  },
}));

// Mock mapping validator and fixer
jest.mock('@/server/services/mappingValidator', () => ({
  validateIndexMappings: jest.fn(),
}));

jest.mock('@/server/services/mappingFixer', () => ({
  fixIndexMappings: jest.fn(),
}));

const mockValidateIndexMappings = validateIndexMappings as jest.Mock;
const mockFixIndexMappings = fixIndexMappings as jest.Mock;

const mockIndicesExists = jest.fn();
const mockIndicesCreate = jest.fn();
const mockIndicesPutSettings = jest.fn();
const mockIndicesPutMapping = jest.fn();

const mockClient = {
  indices: {
    exists: mockIndicesExists,
    create: mockIndicesCreate,
    putSettings: mockIndicesPutSettings,
    putMapping: mockIndicesPutMapping,
  },
} as any;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('ensureIndexes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create indexes that do not exist', async () => {
    mockIndicesExists.mockResolvedValue({ body: false });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });

    const results = await ensureIndexes(mockClient);

    expect(mockIndicesExists).toHaveBeenCalledTimes(4);
    expect(mockIndicesCreate).toHaveBeenCalledTimes(4);
    expect(results['evals_test_cases']).toEqual({ status: 'created' });
    expect(results['evals_experiments']).toEqual({ status: 'created' });
    expect(results['evals_runs']).toEqual({ status: 'created' });
    expect(results['evals_analytics']).toEqual({ status: 'created' });
  });

  it('should update settings and mappings for existing indexes', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockIndicesPutSettings.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesPutMapping.mockResolvedValue({ body: { acknowledged: true } });

    const results = await ensureIndexes(mockClient);

    expect(mockIndicesCreate).not.toHaveBeenCalled();
    // evals_experiments has settings with field limit
    expect(results['evals_experiments']).toEqual(
      expect.objectContaining({
        status: 'exists',
        settingsUpdated: true,
        mappingsUpdated: true,
      })
    );
    // evals_test_cases has no settings, so only mappings updated
    expect(results['evals_test_cases']).toEqual(
      expect.objectContaining({
        status: 'exists',
        mappingsUpdated: true,
      })
    );
  });

  it('should handle settings update failure with warnings', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockIndicesPutSettings.mockRejectedValue(new Error('Settings update blocked'));
    mockIndicesPutMapping.mockResolvedValue({ body: { acknowledged: true } });

    const results = await ensureIndexes(mockClient);

    expect(results['evals_experiments'].status).toBe('exists');
    expect(results['evals_experiments'].warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Failed to update settings')])
    );
    expect(results['evals_experiments'].mappingsUpdated).toBe(true);
  });

  it('should handle mappings update failure with warnings', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockIndicesPutSettings.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesPutMapping.mockRejectedValue(new Error('Mapping conflict'));

    const results = await ensureIndexes(mockClient);

    expect(results['evals_experiments'].status).toBe('exists');
    expect(results['evals_experiments'].settingsUpdated).toBe(true);
    expect(results['evals_experiments'].warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Failed to update mappings')])
    );
  });

  it('should handle index creation errors without throwing', async () => {
    mockIndicesExists.mockResolvedValue({ body: false });
    mockIndicesCreate.mockRejectedValue(new Error('Cluster read-only'));

    const results = await ensureIndexes(mockClient);

    expect(results['evals_test_cases']).toEqual({
      status: 'error',
      error: 'Cluster read-only',
    });
    // All indexes should have results even if they all fail
    expect(Object.keys(results)).toHaveLength(4);
  });

  it('should handle a mix of existing and new indexes', async () => {
    // First two exist, last two don't
    mockIndicesExists
      .mockResolvedValueOnce({ body: true })
      .mockResolvedValueOnce({ body: true })
      .mockResolvedValueOnce({ body: false })
      .mockResolvedValueOnce({ body: false });
    mockIndicesPutSettings.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesPutMapping.mockResolvedValue({ body: { acknowledged: true } });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });

    const results = await ensureIndexes(mockClient);

    const statuses = Object.values(results).map(r => r.status);
    expect(statuses.filter(s => s === 'exists')).toHaveLength(2);
    expect(statuses.filter(s => s === 'created')).toHaveLength(2);
  });
});

describe('ensureIndexesWithValidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all indexes created fresh (no existing data)
    mockIndicesExists.mockResolvedValue({ body: false });
    mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });
  });

  it('should call ensureIndexes then validateIndexMappings', async () => {
    mockValidateIndexMappings.mockResolvedValue([
      { indexName: 'evals_test_cases', status: 'ok', issues: [], documentCount: 0 },
    ]);

    const result = await ensureIndexesWithValidation(mockClient);

    expect(mockIndicesExists).toHaveBeenCalled(); // ensureIndexes called
    expect(mockValidateIndexMappings).toHaveBeenCalledWith(mockClient);
    expect(result.indexResults).toBeDefined();
    expect(result.validationResults).toHaveLength(1);
    expect(result.fixResults).toBeUndefined(); // No fix needed
  });

  it('should not call fixIndexMappings when all mappings are ok', async () => {
    mockValidateIndexMappings.mockResolvedValue([
      { indexName: 'evals_test_cases', status: 'ok', issues: [], documentCount: 5 },
      { indexName: 'evals_runs', status: 'ok', issues: [], documentCount: 10 },
    ]);

    const result = await ensureIndexesWithValidation(mockClient);

    expect(mockFixIndexMappings).not.toHaveBeenCalled();
    expect(result.fixResults).toBeUndefined();
  });

  it('should call fixIndexMappings when validation finds issues', async () => {
    const validationResults = [
      { indexName: 'evals_test_cases', status: 'ok' as const, issues: [], documentCount: 5 },
      {
        indexName: 'evals_runs',
        status: 'needs_reindex' as const,
        issues: [{ indexName: 'evals_runs', field: 'id', expectedType: 'keyword', actualType: 'text', hasKeywordSubfield: false, fixable: true }],
        documentCount: 42,
      },
    ];
    mockValidateIndexMappings.mockResolvedValue(validationResults);
    mockFixIndexMappings.mockResolvedValue([
      { indexName: 'evals_runs', status: 'completed', documentCount: 42 },
    ]);

    const result = await ensureIndexesWithValidation(mockClient);

    // Should only pass the indexes needing fix
    expect(mockFixIndexMappings).toHaveBeenCalledWith(
      mockClient,
      [validationResults[1]], // Only evals_runs
      undefined, // No onProgress callback passed
    );
    expect(result.fixResults).toHaveLength(1);
    expect(result.fixResults![0].status).toBe('completed');
  });

  it('should pass onFixProgress callback to fixIndexMappings', async () => {
    mockValidateIndexMappings.mockResolvedValue([
      {
        indexName: 'evals_runs',
        status: 'needs_reindex',
        issues: [{ indexName: 'evals_runs', field: 'id', expectedType: 'keyword', actualType: 'text', hasKeywordSubfield: false, fixable: true }],
        documentCount: 10,
      },
    ]);
    mockFixIndexMappings.mockResolvedValue([
      { indexName: 'evals_runs', status: 'completed', documentCount: 10 },
    ]);

    const onProgress = jest.fn();
    await ensureIndexesWithValidation(mockClient, onProgress);

    // fixIndexMappings should receive the progress callback
    expect(mockFixIndexMappings).toHaveBeenCalledWith(
      mockClient,
      expect.any(Array),
      onProgress,
    );
  });
});
