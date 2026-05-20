/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeTestCase, TestOptions, EvalResult } from './types.js';

const registries = new Map<string, CodeTestCase[]>();
let activeFile: string | null = null;
const DEFAULT_KEY = '__default__';

// Emit a one-time experimental-status warning the first time the SDK is
// touched, unless the user opts out. This is intentionally noisy enough to be
// noticed but only fires once per process so it doesn't pollute test output.
let experimentalWarningEmitted = false;
function emitExperimentalWarningOnce(): void {
  if (experimentalWarningEmitted) return;
  experimentalWarningEmitted = true;
  if (process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL === '1') return;
  // eslint-disable-next-line no-console
  console.warn(
    '[agent-health] The code-based test SDK (test()/judge()/expect()) is ' +
    'experimental. The API may change in a minor release without a ' +
    'deprecation cycle. Pin your @opensearch-project/agent-health version, ' +
    'or set AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1 to silence this notice.'
  );
}

/** @internal */
export function _resetExperimentalWarning(): void {
  experimentalWarningEmitted = false;
}

export function setActiveFile(filePath: string): void {
  activeFile = filePath;
  if (!registries.has(filePath)) {
    registries.set(filePath, []);
  }
}

/**
 * Register a code-based test case.
 *
 * @experimental The SDK shape (signature, options, body fixtures) may change
 * in a minor release without a deprecation cycle. See `lib/index.ts`.
 *
 * @param name        Human-readable test name. Required.
 * @param options     Test options (prompt, labels, timeout, etc.).
 * @param evaluate    Test body — receives the {@link EvalResult} and asserts.
 */
export function test(
  name: string,
  options: TestOptions,
  evaluate: (result: EvalResult) => Promise<void> | void
): void {
  emitExperimentalWarningOnce();
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
 * @experimental The SDK is experimental — see `lib/index.ts`.
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
