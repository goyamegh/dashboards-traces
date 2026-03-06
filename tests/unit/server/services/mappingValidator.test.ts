/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateIndexMappings } from '@/server/services/mappingValidator';

// Mock index mappings with keyword fields
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'evals_test_cases': {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          category: { type: 'keyword' },
        },
      },
    },
    'evals_runs': {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          experimentId: { type: 'keyword' },
          status: { type: 'keyword' },
        },
      },
    },
  },
}));

const mockIndicesExists = jest.fn();
const mockIndicesGetMapping = jest.fn();
const mockCount = jest.fn();

const mockClient = {
  indices: {
    exists: mockIndicesExists,
    getMapping: mockIndicesGetMapping,
  },
  count: mockCount,
} as any;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('validateIndexMappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return ok when all mappings are correct keyword types', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockCount.mockResolvedValue({ body: { count: 10 } });

    // Both indexes have correct keyword mappings
    mockIndicesGetMapping
      .mockResolvedValueOnce({
        body: {
          'evals_test_cases': {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
                category: { type: 'keyword' },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          'evals_runs': {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                experimentId: { type: 'keyword' },
                status: { type: 'keyword' },
              },
            },
          },
        },
      });

    const results = await validateIndexMappings(mockClient);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(
      expect.objectContaining({ indexName: 'evals_test_cases', status: 'ok', issues: [] })
    );
    expect(results[1]).toEqual(
      expect.objectContaining({ indexName: 'evals_runs', status: 'ok', issues: [] })
    );
  });

  it('should detect text field where keyword is expected', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockCount.mockResolvedValue({ body: { count: 42 } });

    // evals_runs has `id` as text instead of keyword
    mockIndicesGetMapping
      .mockResolvedValueOnce({
        body: {
          'evals_test_cases': {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'text' },
                category: { type: 'keyword' },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          'evals_runs': {
            mappings: {
              properties: {
                id: { type: 'text' },
                experimentId: { type: 'text', fields: { keyword: { type: 'keyword' } } },
                status: { type: 'keyword' },
              },
            },
          },
        },
      });

    const results = await validateIndexMappings(mockClient);

    const runsResult = results.find((r) => r.indexName === 'evals_runs')!;
    expect(runsResult.status).toBe('needs_reindex');
    expect(runsResult.issues).toHaveLength(2);
    expect(runsResult.issues[0]).toEqual(
      expect.objectContaining({
        field: 'id',
        expectedType: 'keyword',
        actualType: 'text',
        hasKeywordSubfield: false,
        fixable: true,
      })
    );
    expect(runsResult.issues[1]).toEqual(
      expect.objectContaining({
        field: 'experimentId',
        expectedType: 'keyword',
        actualType: 'text',
        hasKeywordSubfield: true,
        fixable: true,
      })
    );
    expect(runsResult.documentCount).toBe(42);
  });

  it('should still flag needs_reindex when text field has keyword subfield', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockCount.mockResolvedValue({ body: { count: 5 } });

    mockIndicesGetMapping
      .mockResolvedValueOnce({
        body: {
          'evals_test_cases': {
            mappings: {
              properties: {
                id: { type: 'text', fields: { keyword: { type: 'keyword' } } },
                category: { type: 'keyword' },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          'evals_runs': {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                experimentId: { type: 'keyword' },
                status: { type: 'keyword' },
              },
            },
          },
        },
      });

    const results = await validateIndexMappings(mockClient);

    const tcResult = results.find((r) => r.indexName === 'evals_test_cases')!;
    expect(tcResult.status).toBe('needs_reindex');
    expect(tcResult.issues).toHaveLength(1);
    expect(tcResult.issues[0].hasKeywordSubfield).toBe(true);
  });

  it('should skip non-existent indexes gracefully', async () => {
    // First index exists, second doesn't
    mockIndicesExists
      .mockResolvedValueOnce({ body: true })
      .mockResolvedValueOnce({ body: false });
    mockCount.mockResolvedValue({ body: { count: 0 } });
    mockIndicesGetMapping.mockResolvedValueOnce({
      body: {
        'evals_test_cases': {
          mappings: {
            properties: {
              id: { type: 'keyword' },
              category: { type: 'keyword' },
            },
          },
        },
      },
    });

    const results = await validateIndexMappings(mockClient);

    // Only the existing index should be in results
    expect(results).toHaveLength(1);
    expect(results[0].indexName).toBe('evals_test_cases');
  });

  it('should handle 404 errors on getMapping gracefully', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });

    const error404: any = new Error('index_not_found_exception');
    error404.meta = { statusCode: 404 };
    mockIndicesGetMapping.mockRejectedValue(error404);

    const results = await validateIndexMappings(mockClient);

    // Should skip the index, not throw
    expect(results).toHaveLength(0);
  });

  it('should handle mixed results - some ok, some needing fix', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockCount.mockResolvedValue({ body: { count: 10 } });

    mockIndicesGetMapping
      .mockResolvedValueOnce({
        body: {
          'evals_test_cases': {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                category: { type: 'keyword' },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          'evals_runs': {
            mappings: {
              properties: {
                id: { type: 'text' },
                experimentId: { type: 'keyword' },
                status: { type: 'keyword' },
              },
            },
          },
        },
      });

    const results = await validateIndexMappings(mockClient);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('needs_reindex');
  });

  it('should skip fields that do not exist in actual mappings', async () => {
    mockIndicesExists.mockResolvedValue({ body: true });
    mockCount.mockResolvedValue({ body: { count: 0 } });

    // Actual mapping has no fields at all (freshly created, no docs)
    mockIndicesGetMapping
      .mockResolvedValueOnce({
        body: {
          'evals_test_cases': {
            mappings: {
              properties: {},
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          'evals_runs': {
            mappings: {
              properties: {},
            },
          },
        },
      });

    const results = await validateIndexMappings(mockClient);

    // No issues — fields don't exist yet, ensureIndexes will add them
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('ok');
  });
});
