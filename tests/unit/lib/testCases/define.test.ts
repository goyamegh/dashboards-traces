/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, defineTestCases, getRegisteredTests, clearRegistry, setActiveFile, _resetExperimentalWarning } from '@/lib/testCases/define';

describe('test() API', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers a test case with name + options + body', () => {
    test('My Test', {
      prompt: 'Analyze the issue',
      labels: ['category:RCA', 'difficulty:Medium'],
    }, async () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe('My Test');
    expect(tests[0].options.prompt).toBe('Analyze the issue');
    expect(tests[0].options.labels).toEqual(['category:RCA', 'difficulty:Medium']);
  });

  it('registers a test case with name + body only (no options)', () => {
    test('No options test', () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe('No options test');
    expect(tests[0].options).toEqual({});
  });

  it('registers a test case without a prompt (deterministic test)', () => {
    test('Deterministic only', { labels: ['kind:smoke'] }, () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].options.prompt).toBeUndefined();
    expect(tests[0].options.labels).toEqual(['kind:smoke']);
  });

  it('throws when name is empty', () => {
    expect(() => test('', { prompt: 'p' }, () => {}))
      .toThrow('test() requires a name');
  });

  it('throws when body is not a function (3-arg form)', () => {
    expect(() => test('T', { prompt: 'p' }, null as any))
      .toThrow('requires a body function');
  });

  it('throws when body is not a function (2-arg form)', () => {
    expect(() => (test as any)('T', null))
      .toThrow('requires a body function');
  });

  it('accepts every optional field', () => {
    test('Full Test', {
      prompt: 'Investigate',
      description: 'A full test',
      context: [{ description: 'env', value: 'prod' }],
      labels: ['category:Security', 'difficulty:Hard'],
      timeout: 60000,
    }, () => {});

    const tests = getRegisteredTests();
    expect(tests[0].options.description).toBe('A full test');
    expect(tests[0].options.context).toHaveLength(1);
    expect(tests[0].options.labels).toEqual(['category:Security', 'difficulty:Hard']);
    expect(tests[0].options.timeout).toBe(60000);
  });

  it('registers multiple test cases with distinct names', () => {
    test('Test 1', { prompt: 'p1' }, () => {});
    test('Test 2', { prompt: 'p2' }, () => {});
    test('Test 3', { prompt: 'p3' }, () => {});

    expect(getRegisteredTests()).toHaveLength(3);
  });
});

describe('duplicate detection', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('throws when the same name is registered twice in the same file', () => {
    setActiveFile('/path/dup.eval.js');
    test('login works', { prompt: 'p' }, () => {});
    expect(() => test('login works', { prompt: 'p2' }, () => {}))
      .toThrow(/Duplicate test name "login works"/);
  });

  it('throws even when one form has options and the other does not', () => {
    setActiveFile('/path/dup.eval.js');
    test('foo', () => {});
    expect(() => test('foo', { prompt: 'p' }, () => {}))
      .toThrow(/Duplicate test name "foo"/);
  });

  it('allows the same name in different files (cross-file is fine)', () => {
    setActiveFile('/path/file-a.eval.js');
    test('login', { prompt: 'p' }, () => {});

    setActiveFile('/path/file-b.eval.js');
    expect(() => test('login', { prompt: 'p' }, () => {})).not.toThrow();

    expect(getRegisteredTests('/path/file-a.eval.js')).toHaveLength(1);
    expect(getRegisteredTests('/path/file-b.eval.js')).toHaveLength(1);
  });

  it('mentions the active file in the error message when set', () => {
    setActiveFile('/path/specific.eval.js');
    test('foo', () => {});
    expect(() => test('foo', () => {}))
      .toThrow(/in \/path\/specific\.eval\.js/);
  });
});

describe('file-scoped registries', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('isolates tests by file path', () => {
    setActiveFile('/path/file1.eval.ts');
    test('File1 Test', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('File2 Test', { prompt: 'p' }, () => {});

    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests()).toHaveLength(2);
  });

  it('records sourceFile on each registered test case', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    const tests = getRegisteredTests('/path/file1.eval.ts');
    expect(tests[0].sourceFile).toBe('/path/file1.eval.ts');
  });

  it('clearRegistry with filePath only clears that file', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p' }, () => {});

    clearRegistry('/path/file1.eval.ts');
    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(0);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
  });

  it('clearRegistry without args clears everything', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p' }, () => {});

    clearRegistry();
    expect(getRegisteredTests()).toHaveLength(0);
  });
});

describe('defineTestCases (backward compat)', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('converts legacy format and migrates category/difficulty to labels', () => {
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
    expect(result[0].options.labels).toEqual(['category:Security', 'difficulty:Medium']);

    // Also registered
    expect(getRegisteredTests()).toHaveLength(1);
  });

  it('preserves existing labels and adds category/difficulty alongside', () => {
    const result = defineTestCases([{
      name: 'With Labels',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: 'p',
      labels: ['team:platform'],
      evaluate: () => {},
    }]);

    expect(result[0].options.labels).toEqual(['team:platform', 'category:RCA', 'difficulty:Easy']);
  });

  it('does not duplicate category label when one is already present', () => {
    const result = defineTestCases([{
      name: 'Has Cat',
      category: 'RCA',         // duplicate of label below
      difficulty: 'Easy',
      initialPrompt: 'p',
      labels: ['category:Security'],   // wins
      evaluate: () => {},
    }]);

    expect(result[0].options.labels).toEqual(['category:Security', 'difficulty:Easy']);
  });

  it('accepts legacy entries without category/difficulty/initialPrompt', () => {
    const result = defineTestCases([{
      name: 'Bare Legacy',
      evaluate: () => {},
    }]);

    expect(result).toHaveLength(1);
    expect(result[0].options.labels).toBeUndefined();
    expect(result[0].options.prompt).toBeUndefined();
  });

  it('throws for empty array', () => {
    expect(() => defineTestCases([])).toThrow('non-empty array');
  });

  it('throws for null input', () => {
    expect(() => defineTestCases(null as any)).toThrow();
  });

  it('throws when name is missing', () => {
    expect(() => defineTestCases([{ name: '', evaluate: () => {} }]))
      .toThrow('name');
  });

  it('throws when evaluate function is missing', () => {
    expect(() => defineTestCases([{ name: 'X' } as any]))
      .toThrow('evaluate function');
  });
});

describe('experimental warning', () => {
  let warnSpy: jest.SpyInstance;
  let originalEnv: string | undefined;

  beforeEach(() => {
    clearRegistry();
    _resetExperimentalWarning();
    originalEnv = process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    delete process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalEnv === undefined) {
      delete process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    } else {
      process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL = originalEnv;
    }
  });

  it('emits the experimental warning the first time test() is called', () => {
    test('First', { prompt: 'p' }, async () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/experimental/i);
  });

  it('does not emit again on subsequent test() calls', () => {
    test('First', { prompt: 'p' }, async () => {});
    test('Second', { prompt: 'p' }, async () => {});
    test('Third', { prompt: 'p' }, async () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('is suppressed when AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1 is set', () => {
    process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL = '1';
    test('First', { prompt: 'p' }, async () => {});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
