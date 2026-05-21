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
 * Two valid signatures (Playwright-style):
 * - `test(name, body)` — no options at all
 * - `test(name, options, body)` — with options
 *
 * Only `name` is required. All TestOptions fields are optional. When
 * `options.prompt` is absent, the runner skips agent invocation and the
 * body receives an empty EvalResult.
 *
 * Throws if a test with the same name is already registered in the same
 * source file. Cross-file duplicates are allowed (storage identity is
 * `name + sourceFile`).
 *
 * @experimental The SDK shape (signature, options, body fixtures) may change
 * in a minor release without a deprecation cycle. See `lib/index.ts`.
 */
export function test(
  name: string,
  body: (result: EvalResult) => Promise<void> | void
): void;
export function test(
  name: string,
  options: TestOptions,
  body: (result: EvalResult) => Promise<void> | void
): void;
export function test(
  name: string,
  optionsOrBody: TestOptions | ((result: EvalResult) => Promise<void> | void),
  maybeBody?: (result: EvalResult) => Promise<void> | void
): void {
  emitExperimentalWarningOnce();

  // Resolve the two-arg / three-arg overload
  let options: TestOptions;
  let evaluate: (result: EvalResult) => Promise<void> | void;
  if (typeof optionsOrBody === 'function') {
    options = {};
    evaluate = optionsOrBody;
  } else {
    options = optionsOrBody ?? {};
    evaluate = maybeBody as (result: EvalResult) => Promise<void> | void;
  }

  if (!name || typeof name !== 'string') {
    throw new Error('test() requires a name (the first argument)');
  }
  if (typeof evaluate !== 'function') {
    throw new Error(`test("${name}") requires a body function`);
  }

  const key = activeFile ?? DEFAULT_KEY;
  if (!registries.has(key)) {
    registries.set(key, []);
  }
  const registry = registries.get(key)!;

  // Duplicate detection — within-file uniqueness. Cross-file collisions are
  // fine because storage identity is `name + sourceFile`.
  if (registry.some(t => t.name === name)) {
    const fileLabel = activeFile ? ` in ${activeFile}` : '';
    throw new Error(
      `Duplicate test name "${name}"${fileLabel}. ` +
      `Test names must be unique within a single .eval file. ` +
      `Either rename one of the tests or move them into separate files.`
    );
  }

  registry.push({ name, options, evaluate, sourceFile: activeFile ?? undefined });
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
