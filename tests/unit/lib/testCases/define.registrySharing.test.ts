/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the `.eval.ts` / `.eval.mjs` "Module ... has no test
 * cases" bug.
 *
 * Root cause: `.eval.js` files are `eval()`'d in a synthetic CJS context
 * where `require('@opensearch-project/agent-health')` is intercepted by the
 * loader and handed `lib/testCases/define.js`'s OWN exports directly. But
 * `.eval.ts` / `.eval.mjs` files are loaded via a plain native `import()`,
 * which resolves the package name through Node's normal module resolution
 * (the package's `exports` map). When the host process runs from TypeScript
 * source (dev CLI under tsx) or via a project-local `node_modules` symlink
 * pointing at this repo, that resolution can land on a PHYSICALLY DIFFERENT
 * file on disk (e.g. the compiled `lib/dist/lib/testCases/define.js`) than
 * the one the loader's own code imports internally (the TS source). Two
 * different files means two different ES module instances of `define.ts`,
 * each with its own module-level state — so a `.eval.ts` file's `test()`
 * calls landed in a registry the loader never read from.
 *
 * This test simulates "two module instances" the cheap way available inside
 * Jest: `jest.resetModules()` forces a fresh evaluation of `define.ts`,
 * producing a distinct module object (different top-level `let`/`const`
 * bindings) from the one already `require`d. Before the fix, a test()
 * registered through instance #2 was invisible to instance #1's
 * `getRegisteredTests()` (and vice versa) — exactly the loader/eval-file
 * mismatch. After the fix (state keyed off `globalThis[Symbol.for(...)]`),
 * both instances read and write the same underlying Maps.
 */

describe('define.ts registry sharing across module instances', () => {
  beforeEach(() => {
    // Clear the shared, globalThis-backed registry between tests so
    // instances loaded in earlier tests don't leak into later ones.
    const REGISTRY_KEY = Symbol.for('agent-health.test-registry.v1');
    delete (globalThis as any)[REGISTRY_KEY];
  });

  it('shares registered tests between two distinct module instances of define.ts', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceA = require('@/lib/testCases/define');

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceB = require('@/lib/testCases/define');

    // Sanity check: these really are two different module instances, not
    // Node/Jest handing back the same cached object.
    expect(instanceA).not.toBe(instanceB);
    expect(instanceA.test).not.toBe(instanceB.test);

    const filePath = '/fake/registry-sharing.eval.ts';

    // Instance A plays the role of the loader (lib/testCases/loader.ts),
    // which always imports its OWN define.js internally.
    instanceA.setActiveFile(filePath);

    // Instance B plays the role of a `.eval.ts` file's `import { test }
    // from '@opensearch-project/agent-health'` — resolved to a different
    // physical module than the one the loader uses internally.
    instanceB.test('registered from a different module instance', { prompt: 'hi' }, () => {});

    // The loader (instance A) must see the test that instance B registered.
    const seenByLoader = instanceA.getRegisteredTests(filePath);
    expect(seenByLoader).toHaveLength(1);
    expect(seenByLoader[0].name).toBe('registered from a different module instance');

    // And instance B must see it too (both read the same shared state).
    const seenByEvalFile = instanceB.getRegisteredTests(filePath);
    expect(seenByEvalFile).toHaveLength(1);
    expect(seenByEvalFile[0].name).toBe('registered from a different module instance');
  });

  it('shares hooks (beforeEach/afterEach/beforeAll/afterAll) across module instances', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceA = require('@/lib/testCases/define');

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceB = require('@/lib/testCases/define');

    const filePath = '/fake/registry-sharing-hooks.eval.ts';
    instanceA.setActiveFile(filePath);

    instanceB.beforeEach(() => {});
    instanceB.afterAll(() => {});

    const hooks = instanceA.getRegisteredHooks(filePath);
    expect(hooks.map((h: any) => h.kind).sort()).toEqual(['afterAll', 'beforeEach']);
  });

  it('shares the describe()-derived benchmarkPath across module instances', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceA = require('@/lib/testCases/define');

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceB = require('@/lib/testCases/define');

    const filePath = '/fake/registry-sharing-describe.eval.ts';
    instanceA.setActiveFile(filePath);

    instanceB.describe('RCA Suite', () => {
      instanceB.test('finds root cause', { prompt: 'p' }, () => {});
    });

    const tests = instanceA.getRegisteredTests(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0].benchmarkPath).toBe('RCA Suite');
  });

  it('clearRegistry() on one instance clears state visible to another instance', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceA = require('@/lib/testCases/define');

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instanceB = require('@/lib/testCases/define');

    const filePath = '/fake/registry-sharing-clear.eval.ts';
    instanceA.setActiveFile(filePath);
    instanceB.test('will be cleared', () => {});
    expect(instanceA.getRegisteredTests(filePath)).toHaveLength(1);

    instanceA.clearRegistry(filePath);
    expect(instanceB.getRegisteredTests(filePath)).toHaveLength(0);
  });
});
