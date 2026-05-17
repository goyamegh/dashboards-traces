/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, defineTestCases, getRegisteredTests, clearRegistry, setActiveFile } from '@/lib/testCases/define';

describe('test() API', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers a test case with valid options', () => {
    test('My Test', {
      prompt: 'Analyze the issue',
      category: 'RCA',
      difficulty: 'Medium',
    }, async () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe('My Test');
    expect(tests[0].options.prompt).toBe('Analyze the issue');
    expect(tests[0].options.category).toBe('RCA');
    expect(tests[0].options.difficulty).toBe('Medium');
  });

  it('throws when name is empty', () => {
    expect(() => test('', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {}))
      .toThrow('test() requires a name');
  });

  it('throws when prompt is missing', () => {
    expect(() => test('T', { prompt: '', category: 'RCA', difficulty: 'Easy' }, () => {}))
      .toThrow('requires options.prompt');
  });

  it('throws when category is missing', () => {
    expect(() => test('T', { prompt: 'p', category: '', difficulty: 'Easy' }, () => {}))
      .toThrow('requires options.category');
  });

  it('throws when difficulty is missing', () => {
    expect(() => test('T', { prompt: 'p', category: 'RCA', difficulty: '' as any }, () => {}))
      .toThrow('requires options.difficulty');
  });

  it('throws when evaluate is not a function', () => {
    expect(() => test('T', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, null as any))
      .toThrow('requires an evaluate function');
  });

  it('accepts optional fields in options', () => {
    test('Full Test', {
      prompt: 'Investigate',
      category: 'Security',
      difficulty: 'Hard',
      description: 'A full test',
      context: [{ description: 'env', value: 'prod' }],
      labels: ['security'],
      timeout: 60000,
    }, () => {});

    const tests = getRegisteredTests();
    expect(tests[0].options.description).toBe('A full test');
    expect(tests[0].options.context).toHaveLength(1);
    expect(tests[0].options.labels).toEqual(['security']);
    expect(tests[0].options.timeout).toBe(60000);
  });

  it('registers multiple test cases', () => {
    test('Test 1', { prompt: 'p1', category: 'RCA', difficulty: 'Easy' }, () => {});
    test('Test 2', { prompt: 'p2', category: 'RCA', difficulty: 'Medium' }, () => {});
    test('Test 3', { prompt: 'p3', category: 'Security', difficulty: 'Hard' }, () => {});

    expect(getRegisteredTests()).toHaveLength(3);
  });
});

describe('file-scoped registries', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('isolates tests by file path', () => {
    setActiveFile('/path/file1.eval.ts');
    test('File1 Test', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('File2 Test', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests()).toHaveLength(2);
  });

  it('clearRegistry with filePath only clears that file', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    clearRegistry('/path/file1.eval.ts');
    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(0);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
  });

  it('clearRegistry without args clears everything', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p', category: 'RCA', difficulty: 'Easy' }, () => {});

    clearRegistry();
    expect(getRegisteredTests()).toHaveLength(0);
  });
});

describe('defineTestCases (backward compat)', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('converts legacy format to CodeTestCase and registers', () => {
    const result = defineTestCases([{
      name: 'Legacy Test',
      category: 'Security',
      difficulty: 'Medium',
      initialPrompt: 'Find the bug',
      evaluate: async () => {},
    }]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Legacy Test');
    expect(result[0].options.prompt).toBe('Find the bug');
    expect(result[0].options.category).toBe('Security');

    // Also registered
    expect(getRegisteredTests()).toHaveLength(1);
  });

  it('throws for empty array', () => {
    expect(() => defineTestCases([])).toThrow('non-empty array');
  });

  it('throws for null input', () => {
    expect(() => defineTestCases(null as any)).toThrow();
  });

  it('throws when required fields missing', () => {
    expect(() => defineTestCases([{ name: '', category: 'RCA', difficulty: 'Easy', initialPrompt: 'p', evaluate: () => {} }]))
      .toThrow('name');
  });
});
