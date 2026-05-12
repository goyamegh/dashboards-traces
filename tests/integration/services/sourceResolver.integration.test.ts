/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { resolveTestCaseSources } from '@/services/sourceResolver';
import type { TestCaseSource } from '@/types';

describe('resolveTestCaseSources (integration)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-resolver-test-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Helper to create a valid test case JSON for file import
  // =========================================================================
  function makeTestCaseJson(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Test Case',
      description: 'A test case',
      category: 'RCA',
      difficulty: 'Medium',
      initialPrompt: 'What happened?',
      expectedOutcomes: ['Agent identifies the root cause'],
      ...overrides,
    };
  }

  // =========================================================================
  // type: 'benchmark'
  // =========================================================================
  describe('type: benchmark', () => {
    it('resolves test cases from a benchmark', async () => {
      const tc1 = await storage.testCases.create({ name: 'TC1', initialPrompt: 'p1', expectedOutcomes: ['o1'], category: 'RCA', difficulty: 'Easy' });
      const tc2 = await storage.testCases.create({ name: 'TC2', initialPrompt: 'p2', expectedOutcomes: ['o2'], category: 'RCA', difficulty: 'Hard' });
      const benchmark = await storage.benchmarks.create({ name: 'B1', testCaseIds: [tc1.id, tc2.id] });

      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: benchmark.id }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      expect(result.testCases.map(tc => tc.id)).toEqual(expect.arrayContaining([tc1.id, tc2.id]));
      expect(result.deduplicatedCount).toBe(0);
    });

    it('throws when benchmark not found', async () => {
      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: 'nonexistent-id' }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow('Benchmark not found: nonexistent-id');
    });

    it('throws when a test case in the benchmark is not found', async () => {
      const benchmark = await storage.benchmarks.create({ name: 'B-missing-tc', testCaseIds: ['missing-tc-id'] });
      const sources: TestCaseSource[] = [{ type: 'benchmark', benchmarkId: benchmark.id }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow('Test case not found: missing-tc-id');
    });
  });

  // =========================================================================
  // type: 'test-case-ids'
  // =========================================================================
  describe('type: test-case-ids', () => {
    it('resolves test cases by explicit IDs', async () => {
      const tc = await storage.testCases.create({ name: 'TC-explicit', initialPrompt: 'prompt', expectedOutcomes: ['outcome'], category: 'RCA', difficulty: 'Medium' });
      const sources: TestCaseSource[] = [{ type: 'test-case-ids', ids: [tc.id] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].id).toBe(tc.id);
    });

    it('throws when a test case ID is not found', async () => {
      const sources: TestCaseSource[] = [{ type: 'test-case-ids', ids: ['does-not-exist'] }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow('Test case not found: does-not-exist');
    });
  });

  // =========================================================================
  // type: 'file-import'
  // =========================================================================
  describe('type: file-import', () => {
    it('imports test cases from a JSON file', async () => {
      const filePath = path.join(tmpDir, 'import-test.json');
      const testCases = [makeTestCaseJson({ name: 'Imported TC 1' }), makeTestCaseJson({ name: 'Imported TC 2' })];
      fs.writeFileSync(filePath, JSON.stringify(testCases), 'utf-8');

      const sources: TestCaseSource[] = [{ type: 'file-import', filenames: [filePath], testCaseIds: [] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      expect(result.testCases[0].name).toBe('Imported TC 1');
      expect(result.testCases[1].name).toBe('Imported TC 2');
      // Updated source should contain new testCaseIds
      const updatedSource = result.sources[0] as Extract<TestCaseSource, { type: 'file-import' }>;
      expect(updatedSource.testCaseIds).toHaveLength(2);
    });

    it('throws when file not found', async () => {
      const sources: TestCaseSource[] = [{ type: 'file-import', filenames: ['/nonexistent/path.json'], testCaseIds: [] }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow('File not found: /nonexistent/path.json');
    });

    it('throws when validation fails', async () => {
      const filePath = path.join(tmpDir, 'invalid-test.json');
      fs.writeFileSync(filePath, JSON.stringify([{ invalid: true }]), 'utf-8');

      const sources: TestCaseSource[] = [{ type: 'file-import', filenames: [filePath], testCaseIds: [] }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(`Validation failed for ${filePath}`);
    });
  });

  // =========================================================================
  // type: 'directory-import'
  // =========================================================================
  describe('type: directory-import', () => {
    it('imports test cases from JSON files in a directory', async () => {
      const dirPath = path.join(tmpDir, 'import-dir');
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'a.json'), JSON.stringify([makeTestCaseJson({ name: 'Dir TC A' })]), 'utf-8');
      fs.writeFileSync(path.join(dirPath, 'b.json'), JSON.stringify([makeTestCaseJson({ name: 'Dir TC B' })]), 'utf-8');

      const sources: TestCaseSource[] = [{ type: 'directory-import', dirPaths: [dirPath], testCaseIds: [] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      const names = result.testCases.map(tc => tc.name);
      expect(names).toEqual(expect.arrayContaining(['Dir TC A', 'Dir TC B']));
    });

    it('throws when directory not found', async () => {
      const sources: TestCaseSource[] = [{ type: 'directory-import', dirPaths: ['/nonexistent/dir'], testCaseIds: [] }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow('Directory not found: /nonexistent/dir');
    });

    it('throws when no JSON files in directory', async () => {
      const emptyDir = path.join(tmpDir, 'empty-dir');
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(path.join(emptyDir, 'readme.txt'), 'not json', 'utf-8');

      const sources: TestCaseSource[] = [{ type: 'directory-import', dirPaths: [emptyDir], testCaseIds: [] }];
      await expect(resolveTestCaseSources(sources, storage)).rejects.toThrow(`No JSON files found in directory: ${emptyDir}`);
    });
  });

  // =========================================================================
  // type: 'label-filter'
  // =========================================================================
  describe('type: label-filter', () => {
    it('resolves test cases matching labels', async () => {
      await storage.testCases.create({ name: 'Labeled TC', initialPrompt: 'p', expectedOutcomes: ['o'], category: 'RCA', difficulty: 'Easy', labels: ['priority:high'] });
      await storage.testCases.create({ name: 'Unlabeled TC', initialPrompt: 'p', expectedOutcomes: ['o'], category: 'RCA', difficulty: 'Easy', labels: ['priority:low'] });

      const sources: TestCaseSource[] = [{ type: 'label-filter', labels: ['priority:high'] }];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases.length).toBeGreaterThanOrEqual(1);
      expect(result.testCases.some(tc => tc.name === 'Labeled TC')).toBe(true);
      expect(result.testCases.every(tc => tc.labels?.includes('priority:high'))).toBe(true);
    });
  });

  // =========================================================================
  // Deduplication
  // =========================================================================
  describe('deduplication', () => {
    it('deduplicates test cases by ID (first occurrence wins)', async () => {
      const tc = await storage.testCases.create({ name: 'Dup TC', initialPrompt: 'p', expectedOutcomes: ['o'], category: 'RCA', difficulty: 'Medium' });
      const benchmark = await storage.benchmarks.create({ name: 'B-dup', testCaseIds: [tc.id] });

      const sources: TestCaseSource[] = [
        { type: 'benchmark', benchmarkId: benchmark.id },
        { type: 'test-case-ids', ids: [tc.id] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].id).toBe(tc.id);
      expect(result.deduplicatedCount).toBe(1);
    });
  });

  // =========================================================================
  // Multiple sources combined
  // =========================================================================
  describe('multiple sources', () => {
    it('combines test cases from multiple source types', async () => {
      const tc1 = await storage.testCases.create({ name: 'Multi-1', initialPrompt: 'p1', expectedOutcomes: ['o1'], category: 'RCA', difficulty: 'Easy' });
      const tc2 = await storage.testCases.create({ name: 'Multi-2', initialPrompt: 'p2', expectedOutcomes: ['o2'], category: 'RCA', difficulty: 'Hard' });

      const sources: TestCaseSource[] = [
        { type: 'test-case-ids', ids: [tc1.id] },
        { type: 'test-case-ids', ids: [tc2.id] },
      ];
      const result = await resolveTestCaseSources(sources, storage);

      expect(result.testCases).toHaveLength(2);
      expect(result.sources).toHaveLength(2);
    });
  });
});
