/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard (codex_review round-2 finding on PR #442, same bug
 * class as tests/unit/lib/testCases/loader.tsReload.test.ts): `.eval.mjs`
 * loads via a plain native `import()`, which caches by resolved file URL.
 * Re-loading the exact SAME `.eval.mjs` file a second time in one process
 * (a normal `agent-health benchmark -f` re-run after editing the fixture)
 * would silently return the ALREADY-cached, already-executed module
 * without re-running its top-level `test()` calls -- `clearRegistry()`
 * wipes the registry as usual, but nothing refills it, so the second load
 * surfaces as "has no test cases" with zero code changes. Unlike `.ts`,
 * there is no synthetic-CJS execution path to unify onto for real ESM, so
 * the fix here is a cache-busting query string on every `import()` call
 * (see lib/testCases/loader.ts) rather than a different execution model.
 * Accepted cost: each reload leaks one cached module instance under a
 * never-reused query string for the life of the process -- fine for
 * CLI/server process lifetimes.
 *
 * Run as a real, separate `node` subprocess rather than in-process under
 * Jest: jest-runtime's own module machinery doesn't reliably reproduce a
 * genuine dynamic `import()` of an arbitrary `.mjs` file on disk (observed
 * "Cannot use import statement outside a module" purely inside the Jest
 * test environment) -- a Jest-environment artifact, not a real bug;
 * verified manually against a real `node` invocation outside Jest that
 * the fix works. A genuinely separate `node` subprocess exercises the
 * exact code path a real user (CLI/server) hits.
 */

import { writeFileSync, mkdtempSync, symlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * `.eval.mjs` uses native `import()` with no synthetic-CJS interception,
 * so the bare specifier `@opensearch-project/agent-health` must resolve
 * through REAL Node module resolution -- a project dir with its own
 * symlinked node_modules, mirroring
 * tests/integration/cli/evaltsRegistrySharing.integration.test.ts's setup
 * and docs/SDK.md's documented `.eval.mjs` resolution requirement.
 */
function makeProjectDir(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'ah-loader-mjs-reload-'));
  const scopeDir = join(projectDir, 'node_modules', '@opensearch-project');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(process.cwd(), join(scopeDir, 'agent-health'), 'dir');
  return projectDir;
}

function runInSubprocess(script: string): string {
  const proc = spawnSync(process.execPath, ['--input-type=module'], {
    input: script,
    encoding: 'utf-8',
    cwd: process.cwd(),
  });
  if (proc.status !== 0) {
    throw new Error(`Subprocess failed (status ${proc.status}):\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`);
  }
  return proc.stdout || '';
}

const LOADER_PATH = JSON.stringify(join(process.cwd(), 'lib/dist/lib/testCases/loader.js'));
const DEFINE_PATH = JSON.stringify(join(process.cwd(), 'lib/dist/lib/testCases/define.js'));

describe('loader — .eval.mjs is re-loadable with no ESM cache staleness', () => {
  it('loading the same .eval.mjs file three times in one process re-registers its tests every time', () => {
    const projectDir = makeProjectDir();
    const filePath = join(projectDir, 'reload.eval.mjs');
    writeFileSync(
      filePath,
      `
        import { test } from '@opensearch-project/agent-health';
        test('mjs-reload-case', () => {});
      `,
      'utf8'
    );

    const stdout = runInSubprocess(`
      import { loadTestCasesFromModule } from ${LOADER_PATH};
      import { clearRegistry } from ${DEFINE_PATH};

      for (let i = 0; i < 3; i++) {
        clearRegistry();
        const result = await loadTestCasesFromModule(${JSON.stringify(filePath)});
        console.log('LOAD', i, JSON.stringify(result.testCases.map(tc => tc.name)));
      }
    `);

    // Without the cache-busting query string, native import() would return
    // the already-executed cached module on loads 1 and 2, and the
    // registry (wiped by clearRegistry() but never refilled) would come
    // back empty -- these would print `[]` instead of the case name.
    expect(stdout).toContain('LOAD 0 ["mjs-reload-case"]');
    expect(stdout).toContain('LOAD 1 ["mjs-reload-case"]');
    expect(stdout).toContain('LOAD 2 ["mjs-reload-case"]');
  });

  it('re-loading picks up a content change on disk between loads (no stale cache of the file itself)', () => {
    const projectDir = makeProjectDir();
    const filePath = join(projectDir, 'edited.eval.mjs');
    writeFileSync(
      filePath,
      `
        import { test } from '@opensearch-project/agent-health';
        test('mjs-original-case', () => {});
      `,
      'utf8'
    );

    const stdout = runInSubprocess(`
      import { writeFileSync } from 'fs';
      import { loadTestCasesFromModule } from ${LOADER_PATH};
      import { clearRegistry } from ${DEFINE_PATH};

      clearRegistry();
      const before = await loadTestCasesFromModule(${JSON.stringify(filePath)});
      console.log('BEFORE', JSON.stringify(before.testCases.map(tc => tc.name)));

      writeFileSync(${JSON.stringify(filePath)}, \`
        import { test } from '@opensearch-project/agent-health';
        test('mjs-renamed-case', () => {});
      \`, 'utf8');

      clearRegistry();
      const after = await loadTestCasesFromModule(${JSON.stringify(filePath)});
      console.log('AFTER', JSON.stringify(after.testCases.map(tc => tc.name)));
    `);

    expect(stdout).toContain('BEFORE ["mjs-original-case"]');
    expect(stdout).toContain('AFTER ["mjs-renamed-case"]');
  });
});
