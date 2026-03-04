/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the import CLI command.
 *
 * Tests the core logic: file loading, dedup import call, and benchmark creation.
 * The command action itself has complex dependencies (server lifecycle, ora spinners)
 * so we test the integration of shared utilities and ApiClient methods.
 */

import type { ImportTestCasesResponse } from '@/cli/utils/apiClient';
import { isFilePath, loadAndValidateTestCasesFile } from '@/cli/utils/testCaseFile';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

// Mock fs
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
}));

import { readFileSync } from 'fs';

// Mock chalk for cleaner test output
jest.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
  cyan: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  red: (s: string) => s,
  gray: (s: string) => s,
  bold: (s: string) => s,
}));

describe('Import Command - Helper Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadAndValidateTestCasesFile (shared utility)', () => {
    it('should load valid test cases from file', () => {
      const validData = JSON.stringify([
        {
          name: 'Test 1',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'prompt',
          expectedOutcomes: ['outcome'],
        },
        {
          name: 'Test 2',
          category: 'Performance',
          difficulty: 'Hard',
          initialPrompt: 'prompt 2',
          expectedOutcomes: ['outcome 2'],
        },
      ]);
      (readFileSync as jest.Mock).mockReturnValue(validData);

      const result = loadAndValidateTestCasesFile('test-cases.json');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Test 1');
      expect(result[1].name).toBe('Test 2');
    });

    it('should throw for missing file', () => {
      (readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => loadAndValidateTestCasesFile('missing.json')).toThrow('Cannot read file');
    });

    it('should throw for invalid JSON', () => {
      (readFileSync as jest.Mock).mockReturnValue('not json');

      expect(() => loadAndValidateTestCasesFile('bad.json')).toThrow('Invalid JSON');
    });

    it('should throw for validation errors', () => {
      (readFileSync as jest.Mock).mockReturnValue(JSON.stringify([{}]));

      expect(() => loadAndValidateTestCasesFile('invalid.json')).toThrow('Validation failed');
    });
  });

  describe('Import response summary formatting', () => {
    it('should format summary with all types', () => {
      const importResult: ImportTestCasesResponse = {
        created: 2,
        reused: 3,
        updated: 1,
        testCases: [
          { id: 'tc-1', name: 'A', status: 'created' },
          { id: 'tc-2', name: 'B', status: 'created' },
          { id: 'tc-3', name: 'C', status: 'reused' },
          { id: 'tc-4', name: 'D', status: 'reused' },
          { id: 'tc-5', name: 'E', status: 'reused' },
          { id: 'tc-6', name: 'F', status: 'updated' },
        ],
      };

      // Simulate the summary building logic from the import command
      const summary: string[] = [];
      if (importResult.created > 0) summary.push(`${importResult.created} created`);
      if (importResult.reused > 0) summary.push(`${importResult.reused} reused`);
      if (importResult.updated > 0) summary.push(`${importResult.updated} updated`);

      expect(summary.join(', ')).toBe('2 created, 3 reused, 1 updated');
      expect(importResult.testCases.length).toBe(6);
    });

    it('should omit zero counts from summary', () => {
      const importResult: ImportTestCasesResponse = {
        created: 0,
        reused: 5,
        updated: 0,
        testCases: Array(5).fill({ id: 'tc-1', name: 'A', status: 'reused' as const }),
      };

      const summary: string[] = [];
      if (importResult.created > 0) summary.push(`${importResult.created} created`);
      if (importResult.reused > 0) summary.push(`${importResult.reused} reused`);
      if (importResult.updated > 0) summary.push(`${importResult.updated} updated`);

      expect(summary.join(', ')).toBe('5 reused');
    });
  });

  describe('Benchmark creation from import', () => {
    it('should extract IDs for benchmark creation', () => {
      const importResult: ImportTestCasesResponse = {
        created: 1,
        reused: 1,
        updated: 1,
        testCases: [
          { id: 'tc-new', name: 'New', status: 'created' },
          { id: 'tc-existing', name: 'Existing', status: 'reused' },
          { id: 'tc-updated', name: 'Updated', status: 'updated' },
        ],
      };

      // The import command extracts IDs for benchmark creation
      const testCaseIds = importResult.testCases.map(tc => tc.id);

      expect(testCaseIds).toEqual(['tc-new', 'tc-existing', 'tc-updated']);
    });
  });
});
