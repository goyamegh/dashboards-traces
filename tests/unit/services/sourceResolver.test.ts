/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveTestCaseSources } from '@/services/sourceResolver';
import type { TestCaseSource, TestCase, Benchmark } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

// Mock fs and path
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
}));

jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
}));

jest.mock('@/lib/testCaseValidation', () => ({
  validateTestCasesArrayJson: jest.fn(),
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import * as fs from 'fs';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockValidate = validateTestCasesArrayJson as jest.Mock;

function makeTestCase(id: string, name = `Test Case ${id}`): TestCase {
  return {
    id,
    name,
    description: `Description for ${name}`,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'Test prompt',
    context: [],
    expectedTrajectory: [],
    labels: [],
  } as unknown as TestCase;
}

function createMockStorage(): IStorageModule {
  return {
    testCases: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      search: jest.fn(),
      getVersionHistory: jest.fn(),
    },
    benchmarks: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      getRun: jest.fn(),
      addRun: jest.fn(),
      updateRun: jest.fn(),
      deleteRun: jest.fn(),
    },
    runs: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      getByBenchmarkRun: jest.fn(),
      countsByTestCase: jest.fn(),
      addAnnotation: jest.fn(),
      getAnnotations: jest.fn(),
    },
    analytics: {
      record: jest.fn(),
      query: jest.fn(),
    },
  } as unknown as IStorageModule;
}

describe('resolveTestCaseSources', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
  });

  describe('benchmark source type', () => {
    it('resolves test cases from a benchmark', async () => {
      const tc1 = makeTestCase('tc-1');
      const tc2 = makeTestCase('tc-2');
      const benchmark = { id: 'bench-1', testCaseIds: ['tc-1', 'tc-2'] } as unknown as Benchmark;

      (storage.benchmarks.getById as jest.Mock).mockResolvedValue(benchmark);
      (storage.testCases.getById as jest.Mock)
        .mockResolvedValueOnce(tc1)
        .mockResolvedValueOnce(tc2);

      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: 'bench-1' }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources).toEqual(sources);
      expect(result.deduplicatedCount).toBe(0);
      expect(storage.benchmarks.getById).toHaveBeenCalledWith('bench-1');
    });

    it('throws when benchmark is not found', async () => {
      (storage.benchmarks.getById as jest.Mock).mockResolvedValue(null);

      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: 'missing-bench' }];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Benchmark not found: missing-bench'
      );
    });

    it('throws when a test case in benchmark is not found', async () => {
      const benchmark = { id: 'bench-1', testCaseIds: ['tc-1', 'tc-missing'] } as unknown as Benchmark;

      (storage.benchmarks.getById as jest.Mock).mockResolvedValue(benchmark);
      (storage.testCases.getById as jest.Mock)
        .mockResolvedValueOnce(makeTestCase('tc-1'))
        .mockResolvedValueOnce(null);

      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: 'bench-1' }];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Test case not found: tc-missing'
      );
    });
  });

  describe('test-case-ids source type', () => {
    it('resolves test cases by explicit IDs', async () => {
      const tc1 = makeTestCase('tc-1');
      const tc2 = makeTestCase('tc-2');

      (storage.testCases.getById as jest.Mock)
        .mockResolvedValueOnce(tc1)
        .mockResolvedValueOnce(tc2);

      const sources: TestCaseSource[] = [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources).toEqual(sources);
      expect(result.deduplicatedCount).toBe(0);
    });

    it('throws when a test case ID is not found', async () => {
      (storage.testCases.getById as jest.Mock).mockResolvedValue(null);

      const sources: TestCaseSource[] = [{ type: 'test-case-ids', ids: ['non-existent'] }];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Test case not found: non-existent'
      );
    });

    it('handles empty IDs array', async () => {
      const sources: TestCaseSource[] = [{ type: 'test-case-ids', ids: [] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([]);
      expect(result.deduplicatedCount).toBe(0);
    });
  });

  describe('file-import source type', () => {
    it('imports test cases from a file and populates testCaseIds', async () => {
      const tc1 = makeTestCase('imported-1');
      const tc2 = makeTestCase('imported-2');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ name: 'TC1' }, { name: 'TC2' }]));
      mockValidate.mockReturnValue({ valid: true, data: [{ name: 'TC1' }, { name: 'TC2' }], errors: [] });
      (storage.testCases.bulkCreate as jest.Mock).mockResolvedValue({
        created: 2,
        errors: 0,
        testCases: [tc1, tc2],
      });

      const sources: TestCaseSource[] = [
        { type: 'file-import', filenames: ['/path/to/file.json'], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources[0]).toEqual({
        type: 'file-import',
        filenames: ['/path/to/file.json'],
        testCaseIds: ['imported-1', 'imported-2'],
      });
      expect(result.deduplicatedCount).toBe(0);
    });

    it('throws when file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const sources: TestCaseSource[] = [
        { type: 'file-import', filenames: ['/missing/file.json'], testCaseIds: [] },
      ];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'File not found: /missing/file.json'
      );
    });

    it('throws when validation fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');
      mockValidate.mockReturnValue({
        valid: false,
        data: null,
        errors: [{ message: 'name is required' }],
      });

      const sources: TestCaseSource[] = [
        { type: 'file-import', filenames: ['/path/to/bad.json'], testCaseIds: [] },
      ];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Validation failed for /path/to/bad.json: name is required'
      );
    });

    it('handles multiple files', async () => {
      const tc1 = makeTestCase('tc-from-file1');
      const tc2 = makeTestCase('tc-from-file2');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync
        .mockReturnValueOnce(JSON.stringify([{ name: 'TC1' }]))
        .mockReturnValueOnce(JSON.stringify([{ name: 'TC2' }]));
      mockValidate
        .mockReturnValueOnce({ valid: true, data: [{ name: 'TC1' }], errors: [] })
        .mockReturnValueOnce({ valid: true, data: [{ name: 'TC2' }], errors: [] });
      (storage.testCases.bulkCreate as jest.Mock)
        .mockResolvedValueOnce({ created: 1, errors: 0, testCases: [tc1] })
        .mockResolvedValueOnce({ created: 1, errors: 0, testCases: [tc2] });

      const sources: TestCaseSource[] = [
        { type: 'file-import', filenames: ['/file1.json', '/file2.json'], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources[0]).toMatchObject({
        testCaseIds: ['tc-from-file1', 'tc-from-file2'],
      });
    });
  });

  describe('directory-import source type', () => {
    it('imports test cases from JSON files in a directory', async () => {
      const tc1 = makeTestCase('dir-tc-1');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
      mockFs.readdirSync.mockReturnValue(['case1.json', 'readme.txt'] as any);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ name: 'TC1' }]));
      mockValidate.mockReturnValue({ valid: true, data: [{ name: 'TC1' }], errors: [] });
      (storage.testCases.bulkCreate as jest.Mock).mockResolvedValue({
        created: 1,
        errors: 0,
        testCases: [tc1],
      });

      const sources: TestCaseSource[] = [
        { type: 'directory-import', dirPaths: ['/test/dir'], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1]);
      expect(result.sources[0]).toEqual({
        type: 'directory-import',
        dirPaths: ['/test/dir'],
        testCaseIds: ['dir-tc-1'],
      });
    });

    it('throws when directory does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const sources: TestCaseSource[] = [
        { type: 'directory-import', dirPaths: ['/nonexistent'], testCaseIds: [] },
      ];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Directory not found: /nonexistent'
      );
    });

    it('throws when path is not a directory', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);

      const sources: TestCaseSource[] = [
        { type: 'directory-import', dirPaths: ['/a/file.txt'], testCaseIds: [] },
      ];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'Directory not found: /a/file.txt'
      );
    });

    it('throws when directory has no JSON files', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
      mockFs.readdirSync.mockReturnValue(['readme.txt', 'notes.md'] as any);

      const sources: TestCaseSource[] = [
        { type: 'directory-import', dirPaths: ['/empty/dir'], testCaseIds: [] },
      ];

      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(
        'No JSON files found in directory: /empty/dir'
      );
    });

    it('handles multiple directories', async () => {
      const tc1 = makeTestCase('dir1-tc');
      const tc2 = makeTestCase('dir2-tc');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
      mockFs.readdirSync
        .mockReturnValueOnce(['a.json'] as any)
        .mockReturnValueOnce(['b.json'] as any);
      mockFs.readFileSync
        .mockReturnValueOnce(JSON.stringify([{ name: 'A' }]))
        .mockReturnValueOnce(JSON.stringify([{ name: 'B' }]));
      mockValidate
        .mockReturnValueOnce({ valid: true, data: [{ name: 'A' }], errors: [] })
        .mockReturnValueOnce({ valid: true, data: [{ name: 'B' }], errors: [] });
      (storage.testCases.bulkCreate as jest.Mock)
        .mockResolvedValueOnce({ created: 1, errors: 0, testCases: [tc1] })
        .mockResolvedValueOnce({ created: 1, errors: 0, testCases: [tc2] });

      const sources: TestCaseSource[] = [
        { type: 'directory-import', dirPaths: ['/dir1', '/dir2'], testCaseIds: [] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources[0]).toMatchObject({
        testCaseIds: ['dir1-tc', 'dir2-tc'],
      });
    });
  });

  describe('label-filter source type', () => {
    it('resolves test cases matching labels', async () => {
      const tc1 = makeTestCase('labeled-1');
      const tc2 = makeTestCase('labeled-2');

      (storage.testCases.search as jest.Mock).mockResolvedValue({
        items: [tc1, tc2],
        total: 2,
      });

      const sources: TestCaseSource[] = [
        { type: 'label-filter', labels: ['category:RCA', 'difficulty:Medium'] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([tc1, tc2]);
      expect(result.sources).toEqual(sources);
      expect(result.deduplicatedCount).toBe(0);
      expect(storage.testCases.search).toHaveBeenCalledWith({
        labels: ['category:RCA', 'difficulty:Medium'],
      });
    });

    it('returns empty when no test cases match labels', async () => {
      (storage.testCases.search as jest.Mock).mockResolvedValue({
        items: [],
        total: 0,
      });

      const sources: TestCaseSource[] = [
        { type: 'label-filter', labels: ['nonexistent:label'] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toEqual([]);
      expect(result.deduplicatedCount).toBe(0);
    });
  });

  describe('combined sources', () => {
    it('resolves multiple source types together', async () => {
      const tc1 = makeTestCase('tc-1');
      const tc2 = makeTestCase('tc-2');
      const tc3 = makeTestCase('tc-3');

      // benchmark source
      (storage.benchmarks.getById as jest.Mock).mockResolvedValue({
        id: 'bench-1',
        testCaseIds: ['tc-1'],
      });
      // test-case-ids source + benchmark's tc-1
      (storage.testCases.getById as jest.Mock)
        .mockResolvedValueOnce(tc1) // from benchmark
        .mockResolvedValueOnce(tc2); // from explicit IDs

      // label-filter source
      (storage.testCases.search as jest.Mock).mockResolvedValue({
        items: [tc3],
        total: 1,
      });

      const sources: TestCaseSource[] = [
        { type: 'benchmark', benchmarkId: 'bench-1' },
        { type: 'test-case-ids', ids: ['tc-2'] },
        { type: 'label-filter', labels: ['category:RCA'] },
      ];

      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(3);
      expect(result.testCases).toEqual([tc1, tc2, tc3]);
      expect(result.sources).toHaveLength(3);
      expect(result.deduplicatedCount).toBe(0);
    });
  });

  describe('deduplication', () => {
    it('deduplicates test cases by ID across sources (first occurrence wins)', async () => {
      const tc1 = makeTestCase('tc-1');
      const tc1Duplicate = { ...makeTestCase('tc-1'), name: 'Duplicate TC1' };
      const tc2 = makeTestCase('tc-2');

      (storage.testCases.getById as jest.Mock)
        .mockResolvedValueOnce(tc1) // first source
        .mockResolvedValueOnce(tc1Duplicate) // second source (same ID)
        .mockResolvedValueOnce(tc2); // second source

      const sources: TestCaseSource[] = [
        { type: 'test-case-ids', ids: ['tc-1'] },
        { type: 'test-case-ids', ids: ['tc-1', 'tc-2'] },
      ];

      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      expect(result.testCases[0]).toEqual(tc1); // first occurrence wins
      expect(result.testCases[0].name).toBe('Test Case tc-1');
      expect(result.testCases[1]).toEqual(tc2);
      expect(result.deduplicatedCount).toBe(1);
    });

    it('reports correct deduplication count with multiple duplicates', async () => {
      const tc1 = makeTestCase('tc-1');

      (storage.testCases.getById as jest.Mock).mockResolvedValue(tc1);

      const sources: TestCaseSource[] = [
        { type: 'test-case-ids', ids: ['tc-1'] },
        { type: 'test-case-ids', ids: ['tc-1'] },
        { type: 'test-case-ids', ids: ['tc-1'] },
      ];

      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(1);
      expect(result.deduplicatedCount).toBe(2);
    });

    it('deduplicates across different source types', async () => {
      const tc1 = makeTestCase('shared-tc');

      // From benchmark
      (storage.benchmarks.getById as jest.Mock).mockResolvedValue({
        id: 'bench-1',
        testCaseIds: ['shared-tc'],
      });
      (storage.testCases.getById as jest.Mock).mockResolvedValue(tc1);

      // From label search
      (storage.testCases.search as jest.Mock).mockResolvedValue({
        items: [tc1],
        total: 1,
      });

      const sources: TestCaseSource[] = [
        { type: 'benchmark', benchmarkId: 'bench-1' },
        { type: 'label-filter', labels: ['category:RCA'] },
      ];

      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(1);
      expect(result.deduplicatedCount).toBe(1);
    });
  });

  describe('empty sources', () => {
    it('returns empty results for empty sources array', async () => {
      const result = await resolveTestCaseSources([], storage);

      expect(result.testCases).toEqual([]);
      expect(result.sources).toEqual([]);
      expect(result.deduplicatedCount).toBe(0);
    });
  });
});
