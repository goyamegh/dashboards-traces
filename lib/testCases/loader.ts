/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import type { CodeTestCase } from './types.js';
import { test as testFn, setActiveFile, getRegisteredTests, clearRegistry } from './define.js';

const CODE_EXTENSIONS = ['.ts', '.js', '.mjs'];

export function isCodeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return CODE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function computeTestCaseHash(tc: CodeTestCase): string {
  const content = JSON.stringify({
    name: tc.name,
    prompt: tc.options.prompt,
    category: tc.options.category,
    difficulty: tc.options.difficulty,
    context: tc.options.context,
    labels: tc.options.labels,
    description: tc.options.description,
  });
  return createHash('sha256').update(content).digest('hex');
}

export interface LoadedTestCase extends CodeTestCase {
  hash: string;
}

export interface LoadResult {
  testCases: LoadedTestCase[];
  filePath: string;
}

export async function loadTestCasesFromModule(filePath: string): Promise<LoadResult> {
  const absPath = resolve(filePath);

  // Clear any prior registration for this file and set it as active
  clearRegistry(absPath);
  setActiveFile(absPath);

  let module: any;

  if (absPath.endsWith('.js')) {
    // For CJS .js files, execute in a fresh context with our test() function
    // injected. This avoids module caching issues across multiple loads.
    const code = readFileSync(absPath, 'utf-8');
    const fileDir = dirname(absPath);
    const Module = require('module') as typeof import('module');
    const m = new (Module as any)(absPath);
    m.filename = absPath;
    m.paths = (Module as any)._nodeModulePaths(fileDir);
    // Provide a require function scoped to the file's directory, but override
    // any require of the define module to return our own instance
    const fileRequire = createRequire(absPath);
    const wrappedRequire = (id: string) => {
      const resolved = fileRequire.resolve(id);
      if (resolved === require.resolve('./define.js') || resolved === require.resolve('./define')) {
        return { test: testFn };
      }
      return fileRequire(id);
    };
    (wrappedRequire as any).resolve = fileRequire.resolve;

    const wrapper = `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
    const compiledFn = eval(wrapper);
    compiledFn(m.exports, wrappedRequire, m, absPath, fileDir);
    module = m.exports;
  } else {
    // For .ts and .mjs files, use dynamic import
    try {
      const fileUrl = pathToFileURL(absPath).href;
      module = await import(fileUrl);
    } catch (err: any) {
      if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION' && absPath.endsWith('.ts')) {
        throw new Error(
          `Cannot import TypeScript file: ${filePath}\n` +
          'Install tsx as a dependency: npm install tsx\n' +
          'Or pre-compile .eval.ts to .eval.js before running.'
        );
      }
      throw new Error(`Failed to import module: ${filePath}\n${err.message}`);
    }
  }

  // Support both patterns:
  // 1. test() registration (Playwright-style) → tests are in the registry
  // 2. defineTestCases() / default export (legacy) → tests come from exports
  let testCases = getRegisteredTests(absPath);

  if (testCases.length === 0) {
    // Fall back to default/named export for legacy support
    const exported = module.default ?? module.testCases;
    if (exported && Array.isArray(exported)) {
      testCases = exported;
    }
  }

  if (testCases.length === 0) {
    throw new Error(
      `Module ${filePath} has no test cases. Use test() to register, or export an array via default/named export.`
    );
  }

  // Compute per-test-case hash
  const loaded: LoadedTestCase[] = testCases.map(tc => ({
    ...tc,
    hash: computeTestCaseHash(tc),
  }));

  return { testCases: loaded, filePath: absPath };
}
