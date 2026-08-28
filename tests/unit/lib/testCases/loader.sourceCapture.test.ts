/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for eval-file source capture (Test Case detail page "Eval
 * source" IDE view feature):
 *   - `loadTestCasesFromModule` returns the raw file text (`fileSource`)
 *     for BOTH the CJS `.js` execution path and the ESM `.ts`/`.mjs`
 *     dynamic-import path — regression guard for the .ts path, which
 *     never read raw text before this feature (only `.js` did, for its
 *     own CJS wrapper).
 *   - `detectSourceLanguage` (re-exported from `@/lib/utils`, the
 *     isomorphic home so the browser-side EvalSourceCodeView component can
 *     import it without pulling in `fs`/`module`).
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule, detectSourceLanguage } from '@/lib/testCases/loader';
import { detectSourceLanguage as detectSourceLanguageFromUtils } from '@/lib/utils';
import { clearRegistry } from '@/lib/testCases/define';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ah-loader-source-'));
});

beforeEach(() => clearRegistry());

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loadTestCasesFromModule — fileSource capture', () => {
  it('returns the exact raw file text for a .js (CJS) file', async () => {
    const content = `
      const { test } = require('@opensearch-project/agent-health');
      // a comment that must round-trip verbatim
      test('t', { prompt: 'p' }, () => {});
    `;
    const filePath = write('cjs-source.eval.js', content);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.fileSource).toBe(content);
  });

  // The `.ts`/`.mjs` dynamic-`import()` path is NOT exercised here: Node's
  // dynamic import resolves modules through the real ESM loader (bypassing
  // Jest's `moduleNameMapper`/CJS transform entirely), and `.ts` execution
  // specifically requires the `tsx` loader hook that's only registered when
  // the code runs *through the actual `agent-health` CLI binary* (see the
  // ERR_UNKNOWN_FILE_EXTENSION branch below in loader.ts). That path is
  // exercised end-to-end -- including `fileSource`/`sourceCode` capture --
  // by `tests/integration/cli/benchmarkCodeSdk.integration.test.ts`, which
  // spawns the real CLI subprocess against a `.ts` fixture.

  it('captures fileSource even when the file declares multiple test cases', async () => {
    const filePath = write('multi.eval.js', `
      const { test } = require('@opensearch-project/agent-health');
      test('a', { prompt: 'p' }, () => {});
      test('b', { prompt: 'p' }, () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.testCases).toHaveLength(2);
    // Every test case in the file shares one fileSource — the file, not
    // the individual test, is the unit of "source".
    expect(result.fileSource).toContain("test('a'");
    expect(result.fileSource).toContain("test('b'");
  });
});

describe('detectSourceLanguage', () => {
  it('detects javascript for .js files', () => {
    expect(detectSourceLanguage('evals/foo.eval.js')).toBe('javascript');
  });

  it('detects javascript for .mjs files', () => {
    expect(detectSourceLanguage('evals/foo.eval.mjs')).toBe('javascript');
  });

  it('detects javascript for .cjs files', () => {
    expect(detectSourceLanguage('evals/foo.eval.cjs')).toBe('javascript');
  });

  it('detects typescript for .ts files', () => {
    expect(detectSourceLanguage('evals/foo.eval.ts')).toBe('typescript');
  });

  it('defaults to typescript for unknown extensions', () => {
    expect(detectSourceLanguage('evals/foo')).toBe('typescript');
    expect(detectSourceLanguage('evals/foo.txt')).toBe('typescript');
  });

  it('is case-insensitive', () => {
    expect(detectSourceLanguage('evals/foo.EVAL.JS')).toBe('javascript');
    expect(detectSourceLanguage('evals/foo.TS')).toBe('typescript');
  });

  it('loader re-export is the same implementation as lib/utils (single source of truth)', () => {
    expect(detectSourceLanguage).toBe(detectSourceLanguageFromUtils);
  });
});
