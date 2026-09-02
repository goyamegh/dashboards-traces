/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guards (codex_review round-2 finding on PR #442): esbuild's
 * transform-only CJS rewrite of an .eval.ts file turns
 * `import './helper' from './helper.ts'` into a plain `require('./helper.ts')`
 * -- which plain CommonJS cannot load at all (no `.ts` extension handler
 * registered) -- and turns an ESM-only package import into a `require(...)`
 * that (on Node versions without native `require(esm)` support) throws
 * `ERR_REQUIRE_ESM`. `wrappedRequire` inside `runAsSyntheticCjs`
 * (lib/testCases/loader.ts) now recursively transpiles+executes any
 * require that resolves to a `.ts` file through the SAME synthetic-CJS
 * mechanism, and turns a genuine `ERR_REQUIRE_ESM` into an actionable
 * error instead of a raw Node internal one.
 */

import { writeFileSync, mkdtempSync, symlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';

// esbuild's `require(esm)` interop landed as a stable Node feature in
// 22.12+ (surfaced as `process.features.require_module`) -- on those Node
// versions, `require('chalk')` (a real ESM-only package, already a
// dependency of this repo) succeeds transparently via Node's own interop
// rather than reaching our loader's error path at all. Both outcomes are
// "working as intended" for their respective Node version; the assertion
// below picks the one that actually applies to whatever Node is running
// this test (matching the same Node-version-conditional reality the SDK/CI
// note documents for `.eval.ts` itself).
const nodeHasRequireEsmInterop = Boolean((process.features as any)?.require_module);

/**
 * Every fixture here needs `@opensearch-project/agent-health` to resolve
 * for real (unlike the package-name-interception fast path, a NESTED
 * `require('./helper.ts')` reaches real Node resolution for the relative
 * specifier itself, so the fixture directory needs a real project shape) --
 * mirrors the symlinked-project setup
 * tests/integration/cli/evaltsRegistrySharing.integration.test.ts uses for
 * the same reason, at the unit level (no server/CLI subprocess needed
 * here since we call `loadTestCasesFromModule` directly).
 */
function makeProjectDir(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'ah-loader-multifile-'));
  const scopeDir = join(projectDir, 'node_modules', '@opensearch-project');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(process.cwd(), join(scopeDir, 'agent-health'), 'dir');
  // Also symlink a real ESM-only dependency (chalk -- already in this
  // repo's own package.json dependencies) into the fixture project's own
  // node_modules, so the ESM-only-import test below resolves it for real
  // instead of silently hitting MODULE_NOT_FOUND (the temp dir lives
  // outside the repo tree, so plain upward node_modules resolution from
  // inside it would never reach the repo's own node_modules/chalk).
  const chalkDir = join(projectDir, 'node_modules', 'chalk');
  symlinkSync(join(process.cwd(), 'node_modules', 'chalk'), chalkDir, 'dir');
  return projectDir;
}

describe('loader — multi-file .eval.ts (nested .ts requires)', () => {
  beforeEach(() => clearRegistry());

  it('a main .eval.ts file that imports a sibling ./helper.ts loads and registers its test', async () => {
    const projectDir = makeProjectDir();
    writeFileSync(
      join(projectDir, 'helper.ts'),
      `
        export function greet(name: string): string {
          return 'hello ' + name;
        }
      `,
      'utf8'
    );
    const mainPath = join(projectDir, 'main.eval.ts');
    writeFileSync(
      mainPath,
      `
        import { test } from '@opensearch-project/agent-health';
        import { greet } from './helper.ts';

        test('multi-file-case', () => {
          if (greet('world') !== 'hello world') {
            throw new Error('helper import broken');
          }
        });
      `,
      'utf8'
    );

    const result = await loadTestCasesFromModule(mainPath);

    expect(result.testCases.map(tc => tc.name)).toEqual(['multi-file-case']);
  });

  it('a helper .ts required twice from the main file is transpiled and executed only once per load (per-load cache, not cross-load)', async () => {
    const projectDir = makeProjectDir();
    writeFileSync(
      join(projectDir, 'counted-helper.ts'),
      `
        // A module-level side effect: if this file is executed twice within
        // ONE load, the registry would see two increments instead of one.
        (globalThis as any).__helperLoadCount = ((globalThis as any).__helperLoadCount || 0) + 1;
        export const loadCount = (globalThis as any).__helperLoadCount;
      `,
      'utf8'
    );
    const mainPath = join(projectDir, 'double-require.eval.ts');
    writeFileSync(
      mainPath,
      `
        import { test } from '@opensearch-project/agent-health';
        import { loadCount as a } from './counted-helper.ts';
        import { loadCount as b } from './counted-helper.ts';

        test('double-require-case', () => {
          if (a !== b) throw new Error('helper executed more than once: ' + a + ' vs ' + b);
        });
      `,
      'utf8'
    );
    (globalThis as any).__helperLoadCount = 0;

    const result = await loadTestCasesFromModule(mainPath);

    expect(result.testCases.map(tc => tc.name)).toEqual(['double-require-case']);
    expect((globalThis as any).__helperLoadCount).toBe(1);
    delete (globalThis as any).__helperLoadCount;
  });

  it('an ESM-only package import produces the friendly SDK error on Node without require(esm) interop, or loads fine on Node that has it', () => {
    // Run under a REAL, separate Node process rather than in-process under
    // Jest: jest-runtime patches Node's own module-loading machinery for
    // its transform/mocking pipeline, so a `require()` of an ESM-only
    // package inside THIS test process throws a plain jest-runtime
    // SyntaxError rather than Node's real `ERR_REQUIRE_ESM` -- an artifact
    // of the Jest test environment, not of the loader or of real CLI/server
    // usage (verified manually against a real `node` invocation outside
    // Jest). A genuinely separate `node` subprocess exercises the exact
    // code path a real user hits.
    const projectDir = makeProjectDir();
    const mainPath = join(projectDir, 'esm-only.eval.ts');
    writeFileSync(
      mainPath,
      `
        import { test } from '@opensearch-project/agent-health';
        import chalk from 'chalk';

        test('esm-only-case', () => {
          chalk.red('never actually asserted on — importing is the point');
        });
      `,
      'utf8'
    );
    const runnerPath = join(projectDir, 'run.mjs');
    writeFileSync(
      runnerPath,
      `
        import { loadTestCasesFromModule } from ${JSON.stringify(join(process.cwd(), 'lib/dist/lib/testCases/loader.js'))};
        try {
          const result = await loadTestCasesFromModule(${JSON.stringify(mainPath)});
          console.log('LOAD_OK', JSON.stringify(result.testCases.map(tc => tc.name)));
        } catch (err) {
          console.log('LOAD_ERROR', err.message);
        }
      `,
      'utf8'
    );

    const proc = spawnSync(process.execPath, [runnerPath], { encoding: 'utf-8', cwd: process.cwd() });
    const stdout = proc.stdout || '';

    if (nodeHasRequireEsmInterop) {
      expect(stdout).toContain('LOAD_OK');
      expect(stdout).toContain('esm-only-case');
    } else {
      expect(stdout).toContain('LOAD_ERROR');
      expect(stdout).toContain('cannot import ESM-only packages via require()');
      expect(stdout).toContain('chalk');
    }
  });
});
