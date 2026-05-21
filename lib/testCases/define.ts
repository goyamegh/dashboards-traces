/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeTestCase, TestOptions, EvalResult } from './types.js';

const registries = new Map<string, CodeTestCase[]>();
let activeFile: string | null = null;
const DEFAULT_KEY = '__default__';

// Active describe stack (synchronous push/pop). Each entry is a describe
// name; nested describes accumulate. When test() runs, it captures the
// current stack and joins with ' > ' to derive the test's benchmarkPath.
const describeStack: string[] = [];

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

  // Within-file uniqueness guard: a name+benchmarkPath pair must be unique.
  // The same name in two different describe blocks is allowed because they
  // map to different benchmarks.
  const benchmarkPath = describeStack.length > 0 ? describeStack.join(' > ') : undefined;
  if (registry.some(t => t.name === name && t.benchmarkPath === benchmarkPath)) {
    const fileLabel = activeFile ? ` in ${activeFile}` : '';
    const groupLabel = benchmarkPath ? ` (in describe "${benchmarkPath}")` : '';
    throw new Error(
      `Duplicate test name "${name}"${groupLabel}${fileLabel}. ` +
      `Test names must be unique within their describe block. ` +
      `Move one of the tests to a different describe() or rename it.`
    );
  }

  registry.push({
    name,
    options,
    evaluate,
    sourceFile: activeFile ?? undefined,
    benchmarkPath,
  });
}

/**
 * Group tests under a benchmark name. Equivalent to Playwright's
 * `describe()` — the wrapped `test()` calls inherit the describe's name as
 * their benchmark group. Nested describes flatten with ' > '.
 *
 * @example
 *   describe('RCA Suite', () => {
 *     test('payment-service is the root cause', { prompt: ... }, async ({ result, judge }) => {
 *       expect(result.trajectory).to.haveCalledTool('search_logs');
 *       await judge(result, 'identifies the failing dependency');
 *     });
 *   });
 *
 * The describe body MUST be synchronous (no `await`/dynamic content), like
 * Playwright. The function is invoked once at registration time.
 */
export function describe(name: string, fn: () => void): void {
  emitExperimentalWarningOnce();
  if (!name || typeof name !== 'string') {
    throw new Error('describe() requires a name (the first argument)');
  }
  if (typeof fn !== 'function') {
    throw new Error(`describe("${name}") requires a body function`);
  }
  describeStack.push(name);
  try {
    const result = fn() as unknown;
    if (result && typeof (result as any).then === 'function') {
      // Mirror Playwright — describe bodies must be synchronous because
      // they run during registration, well before any test executes.
      throw new Error(
        `describe("${name}") body returned a Promise. ` +
        `describe blocks must be synchronous — use test() inside, not await.`
      );
    }
  } finally {
    describeStack.pop();
  }
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
