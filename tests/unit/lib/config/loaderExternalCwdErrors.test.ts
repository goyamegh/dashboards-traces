/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-fixture regression tests for the two decorated config-loading error
 * messages added to lib/config/loader.ts's loadUserConfig() (CLI DX A5.2/A5.3):
 *
 * - A module-resolution failure (the shape Node throws for a bare-specifier
 *   / ESM resolution miss, e.g. running from a cwd whose package.json lacks
 *   `"type": "module"`) gets a hint to set that field.
 * - A TypeScript/tsconfig-flavored failure gets a hint to set
 *   TSX_TSCONFIG_PATH.
 *
 * Unlike tests/unit/lib/config/loader.test.ts (which mocks `fs` wholesale to
 * unit-test the happy path / caching), these tests write real
 * agent-health.config.mjs fixtures to a real temp directory and let
 * loadConfig() do a real dynamic `import()` against them, so the decoration
 * logic in loadUserConfig()'s catch block runs for real against a real
 * thrown error — only the *triggering* error message is a controlled fixture
 * (loadUserConfig only ever branches on `error.message` substrings, so a
 * fixture that throws the same message shape exercises the exact same code
 * path a real resolution/parse failure would, without depending on Node's
 * exact wording — which is not reproducible inside Jest's own module loader;
 * see the first test's comment for why).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig, clearConfigCache } from '@/lib/config/loader';

describe('loadConfig — external-cwd error message guidance (A5.2/A5.3)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearConfigCache();
  });

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeConfigFixture(fileBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ah-config-fixture-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'agent-health.config.mjs'), fileBody, 'utf-8');
    return dir;
  }

  it('decorates a module-resolution failure with the package.json {"type":"module"} hint', async () => {
    // loadUserConfig()'s catch only inspects error.message — it takes this
    // branch for ERR_MODULE_NOT_FOUND / "Cannot find" (Node's real wording
    // for an ESM resolution miss, e.g. a consumer's cwd lacking
    // `"type": "module"`). A fixture that throws that exact shape at import
    // time is a deterministic, Node-version-independent trigger for the
    // branch (Jest's own module loader intercepts dynamic import() of real
    // ESM `import` syntax before Node's resolver ever runs, so asserting
    // against Node's *actual* resolution-miss text is not reproducible
    // inside this test runner — the branch itself only cares about the
    // message substring, which this exercises faithfully).
    const dir = makeConfigFixture(
      `throw new Error("Cannot find module './does-not-exist.mjs'");\n`
    );

    await expect(loadConfig(dir, true)).rejects.toThrow(/package\.json.*"type":\s*"module"/s);
  });

  it('decorates a tsconfig-flavored failure with the TSX_TSCONFIG_PATH hint', async () => {
    // Same principle: any thrown error mentioning "tsconfig" takes this
    // branch, whether it came from a real parse failure or (as here) the
    // config module's own code.
    const dir = makeConfigFixture(`throw new Error('tsconfig parse failed');\n`);

    await expect(loadConfig(dir, true)).rejects.toThrow(/TSX_TSCONFIG_PATH/);
  });

  it('does not add either hint for an unrelated error', async () => {
    const dir = makeConfigFixture(`throw new Error('boom: unrelated failure');\n`);

    try {
      await loadConfig(dir, true);
      throw new Error('expected loadConfig to reject');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('boom: unrelated failure');
      expect(message).not.toContain('TSX_TSCONFIG_PATH');
      expect(message).not.toContain('"type":"module"');
    }
  });
});
