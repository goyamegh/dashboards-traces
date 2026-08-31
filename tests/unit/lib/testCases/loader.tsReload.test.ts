/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard (codex_review finding on PR #442): before this fix,
 * `.eval.ts` went through a native `import()` on Node 22.6+/24 (native
 * TypeScript type-stripping) and only fell back to an esbuild transpile on
 * older Node. Native `import()` caches by resolved file URL, so re-loading
 * the exact SAME `.eval.ts` file a second time in one process (e.g. the
 * CLI/server re-importing a fixture after it was edited on disk — a normal
 * `agent-health benchmark -f` re-run) silently returned the ALREADY-cached,
 * already-executed module without ever re-running its top-level `test()`
 * calls. `clearRegistry()` wiped the registry as usual, but nothing
 * refilled it, so the second load surfaced as "Module ... has no test
 * cases" with zero code changes. `.eval.js` never had this problem — its
 * synthetic-CJS path builds a fresh `Module` and `eval()`s the source on
 * every call. `.eval.ts` now routes through that exact same never-cached
 * path unconditionally (see lib/testCases/loader.ts), so this must pass on
 * every Node version, not just the ones without native type-stripping.
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';

describe('loader — .eval.ts is re-loadable with no ESM cache staleness', () => {
  it('loading the same .eval.ts file twice in one process re-registers its tests both times', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ah-loader-ts-reload-'));
    const filePath = join(tmp, 'reload.eval.ts');
    writeFileSync(
      filePath,
      `
        import { test } from '@opensearch-project/agent-health';
        test('reload-case', () => {
          // deterministic, no-prompt: nothing to run/assert here beyond
          // registration itself.
        });
      `,
      'utf8'
    );

    clearRegistry();
    const first = await loadTestCasesFromModule(filePath);
    expect(first.testCases.map(tc => tc.name)).toEqual(['reload-case']);

    // A prior implementation's native import() would return the cached
    // module here without re-executing it, so the second load's registry
    // would come back empty (getRegisteredTests -> [] -> "has no test
    // cases" thrown) despite the exact same file on disk.
    clearRegistry();
    const second = await loadTestCasesFromModule(filePath);
    expect(second.testCases.map(tc => tc.name)).toEqual(['reload-case']);

    // A third load, for good measure — proves this isn't a "works exactly
    // twice" artifact of some other caching layer.
    clearRegistry();
    const third = await loadTestCasesFromModule(filePath);
    expect(third.testCases.map(tc => tc.name)).toEqual(['reload-case']);
  });

  it('re-loading picks up a content change on disk between loads (no stale cache of the file itself)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ah-loader-ts-reload-edit-'));
    const filePath = join(tmp, 'edited.eval.ts');
    writeFileSync(
      filePath,
      `
        import { test } from '@opensearch-project/agent-health';
        test('original-case', () => {});
      `,
      'utf8'
    );

    clearRegistry();
    const before = await loadTestCasesFromModule(filePath);
    expect(before.testCases.map(tc => tc.name)).toEqual(['original-case']);

    writeFileSync(
      filePath,
      `
        import { test } from '@opensearch-project/agent-health';
        test('renamed-case', () => {});
      `,
      'utf8'
    );

    clearRegistry();
    const after = await loadTestCasesFromModule(filePath);
    expect(after.testCases.map(tc => tc.name)).toEqual(['renamed-case']);
  });
});
