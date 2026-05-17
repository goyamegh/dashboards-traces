/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeTestCase, TestOptions, EvalResult } from './types.js';

const registries = new Map<string, CodeTestCase[]>();
let activeFile: string | null = null;
const DEFAULT_KEY = '__default__';

export function setActiveFile(filePath: string): void {
  activeFile = filePath;
  if (!registries.has(filePath)) {
    registries.set(filePath, []);
  }
}

export function test(
  name: string,
  options: TestOptions,
  evaluate: (result: EvalResult) => Promise<void> | void
): void {
  if (!name || typeof name !== 'string') throw new Error('test() requires a name');
  if (!options.prompt) throw new Error(`test("${name}") requires options.prompt`);
  if (!options.category) throw new Error(`test("${name}") requires options.category`);
  if (!options.difficulty) throw new Error(`test("${name}") requires options.difficulty`);
  if (typeof evaluate !== 'function') throw new Error(`test("${name}") requires an evaluate function`);

  const key = activeFile ?? DEFAULT_KEY;
  if (!registries.has(key)) {
    registries.set(key, []);
  }
  registries.get(key)!.push({ name, options, evaluate });
}

export function getRegisteredTests(filePath?: string): CodeTestCase[] {
  if (filePath) return [...(registries.get(filePath) ?? [])];
  return [...registries.values()].flatMap(r => [...r]);
}

export function clearRegistry(filePath?: string): void {
  if (filePath) {
    registries.delete(filePath);
  } else {
    registries.clear();
  }
  activeFile = null;
}

/**
 * @deprecated Use test() instead. This wrapper exists for backward compatibility.
 */
export function defineTestCases(cases: Array<{
  name: string;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  initialPrompt: string;
  description?: string;
  context?: { description: string; value: string }[];
  labels?: string[];
  evaluate: (result: EvalResult) => Promise<void> | void;
}>): CodeTestCase[] {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('defineTestCases requires a non-empty array of test cases');
  }
  const result: CodeTestCase[] = [];
  for (const tc of cases) {
    if (!tc.name) throw new Error('Each test case must have a name');
    if (!tc.initialPrompt) throw new Error(`Test case "${tc.name}" must have an initialPrompt`);
    if (!tc.evaluate) throw new Error(`Test case "${tc.name}" must have an evaluate function`);
    if (!tc.category) throw new Error(`Test case "${tc.name}" must have a category`);
    if (!tc.difficulty) throw new Error(`Test case "${tc.name}" must have a difficulty`);

    const codeTestCase: CodeTestCase = {
      name: tc.name,
      options: {
        prompt: tc.initialPrompt,
        category: tc.category,
        difficulty: tc.difficulty,
        description: tc.description,
        context: tc.context,
        labels: tc.labels,
      },
      evaluate: tc.evaluate,
    };
    result.push(codeTestCase);

    // Also register it
    const key = activeFile ?? DEFAULT_KEY;
    if (!registries.has(key)) {
      registries.set(key, []);
    }
    registries.get(key)!.push(codeTestCase);
  }
  return result;
}
