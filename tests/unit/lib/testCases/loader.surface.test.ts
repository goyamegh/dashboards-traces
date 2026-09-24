/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loader unification (#232, RFC 004 §4.7): the CJS `.js` require() surface
 * must expose the SAME authoring API as the `.ts`/`.mjs` import surface, so
 * a new export doesn't silently work in one and be `undefined` in the other.
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';
import { clearEvaluators, getEvaluator } from '@/lib/testCases/evaluators';
import { getAuthoringSurface, AUTHORING_SURFACE_NAMES } from '@/lib/testCases/authoringSurface';
import * as pkg from '@/lib/index';

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ah-loader-surface-')); });
beforeEach(() => { clearRegistry(); clearEvaluators(); });

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loader — authoring surface unification (#232)', () => {
  it('a .js file can require() defineEvaluator and register a test (was undefined before unification)', async () => {
    const filePath = write('uses-define-evaluator.eval.js', `
      const { test, defineEvaluator } = require('@opensearch-project/agent-health');
      defineEvaluator('len-check', ({ result }) => ({ pass: result.agentOutput.length > 0 }));
      test('t1', { prompt: 'hi' }, async ({ agent, evaluate }) => {
        const r = await agent.run();
        await evaluate(r, 'len-check');
      });
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.testCases).toHaveLength(1);
    // The evaluator registered from inside the .js file is globally visible.
    expect(getEvaluator('len-check')).toBeDefined();
  });

  it('the .js require() surface exposes every authoring name', async () => {
    const filePath = write('surface-probe.eval.js', `
      const sdk = require('@opensearch-project/agent-health');
      module.exports.keys = Object.keys(sdk);
      sdk.test('probe', { prompt: 'x' }, () => {});
    `);
    await loadTestCasesFromModule(filePath);
    // getAuthoringSurface is the single source of truth; assert all its
    // names are real (functions) so the .js path can't hand back undefined.
    const surface = getAuthoringSurface();
    for (const name of AUTHORING_SURFACE_NAMES) {
      expect(typeof surface[name]).not.toBe('undefined');
    }
  });

  it('every authoring-surface name is also a real export of the public package', () => {
    // Locks .js (surface object) and .ts/.mjs (package import) to the same
    // set — the core of #232. If someone adds to one, this fails until both
    // agree.
    for (const name of AUTHORING_SURFACE_NAMES) {
      expect((pkg as any)[name]).toBeDefined();
    }
  });

  it('a .js file written against a fork-scoped publish gets the same SDK surface', async () => {
    // A fork renames the package (e.g. `@myorg/agent-health`); eval files
    // authored against that install must still hand back our test()
    // registrar instead of falling through to Node's resolver.
    const filePath = write('fork-scope.eval.js', `
      const { test } = require('@myorg/agent-health');
      test('fork-scoped', { prompt: 'hi' }, async () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0].name).toBe('fork-scoped');
  });

  it('a bare `agent-health` require still resolves to the SDK surface', async () => {
    const filePath = write('bare-name.eval.js', `
      const sdk = require('agent-health');
      sdk.test('bare-name', { prompt: 'hi' }, async () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0].name).toBe('bare-name');
  });
});
