/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs';
import { isFilePath, loadAndValidateTestCasesFile } from '@/cli/utils/testCaseFile';

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
}));

describe('testCaseFile utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isFilePath', () => {
    it('should detect .json extension', () => {
      expect(isFilePath('test-cases.json')).toBe(true);
    });

    it('should detect .JSON extension (case-insensitive)', () => {
      expect(isFilePath('test-cases.JSON')).toBe(true);
    });

    it('should detect path with .json extension', () => {
      expect(isFilePath('./path/to/test-cases.json')).toBe(true);
    });

    it('should return false for benchmark names', () => {
      expect(isFilePath('My Benchmark')).toBe(false);
    });

    it('should return false for benchmark IDs', () => {
      expect(isFilePath('bench-123456')).toBe(false);
    });

    it('should return false for strings containing json but not ending with .json', () => {
      expect(isFilePath('json-benchmark')).toBe(false);
    });
  });

  describe('loadAndValidateTestCasesFile', () => {
    it('should load and validate a valid JSON file', () => {
      const validData = JSON.stringify([
        {
          name: 'Test Case 1',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Investigate the issue',
          expectedOutcomes: ['Find root cause'],
        },
      ]);
      (readFileSync as jest.Mock).mockReturnValue(validData);

      const result = loadAndValidateTestCasesFile('test.json');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Case 1');
    });

    it('should throw on unreadable file', () => {
      (readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      expect(() => loadAndValidateTestCasesFile('missing.json')).toThrow('Cannot read file');
    });

    it('should throw on invalid JSON', () => {
      (readFileSync as jest.Mock).mockReturnValue('{ broken json');

      expect(() => loadAndValidateTestCasesFile('bad.json')).toThrow('Invalid JSON');
    });

    it('should throw on validation failure', () => {
      (readFileSync as jest.Mock).mockReturnValue(JSON.stringify([{ name: '' }]));

      expect(() => loadAndValidateTestCasesFile('invalid.json')).toThrow('Validation failed');
    });

    it('should handle a single object (auto-wrap)', () => {
      const singleObject = JSON.stringify({
        name: 'Single Test',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Check this',
        expectedOutcomes: ['Expected result'],
      });
      (readFileSync as jest.Mock).mockReturnValue(singleObject);

      const result = loadAndValidateTestCasesFile('single.json');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Single Test');
    });
  });
});
