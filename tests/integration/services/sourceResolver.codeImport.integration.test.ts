/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { resolveTestCaseSources } from '@/services/sourceResolver';
import type { TestCaseSource } from '@/types';

describe('resolveTestCaseSources - code-import (integration)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-import-test-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEvalFile(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('imports test cases from a .js file using test() API and returns evaluateFnMap', async () => {
    const evalFile = writeEvalFile('simple.eval.js', `
      const { test } = require('${path.resolve(__dirname, '../../../lib/testCases/define')}');

      test('Integration Test Case', {
        prompt: 'What went wrong?',
        category: 'RCA',
        difficulty: 'Easy',
      }, (result) => {
        if (!result.trajectory) throw new Error('No trajectory');
      });
    `);

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: [evalFile], testCaseIds: [] },
    ];

    const result = await resolveTestCaseSources(sources, storage);

    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0].name).toBe('Integration Test Case');
    expect(result.testCases[0].sourceFile).toBeDefined();
    expect(result.testCases[0].sourceHash).toBeDefined();
    expect(result.evaluateFnMap.size).toBe(1);
    expect(result.evaluateFnMap.has(result.testCases[0].id)).toBe(true);
  });

  it('idempotent: second import with same content produces unchanged', async () => {
    const evalFile = writeEvalFile('idempotent.eval.js', `
      const { test } = require('${path.resolve(__dirname, '../../../lib/testCases/define')}');

      test('Idempotent Case', {
        prompt: 'Check for vulnerabilities',
        category: 'Security',
        difficulty: 'Hard',
      }, () => {});
    `);

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: [evalFile], testCaseIds: [] },
    ];

    const first = await resolveTestCaseSources(sources, storage);
    expect(first.testCases).toHaveLength(1);
    const firstId = first.testCases[0].id;

    const second = await resolveTestCaseSources(sources, storage);
    expect(second.testCases).toHaveLength(1);
    expect(second.testCases[0].id).toBe(firstId);
  });

  it('creates new version when test case content changes', async () => {
    const evalPath = path.join(tmpDir, 'versioned.eval.js');
    const requirePath = path.resolve(__dirname, '../../../lib/testCases/define');

    // V1
    fs.writeFileSync(evalPath, `
      const { test } = require('${requirePath}');
      test('Versioned Case', {
        prompt: 'Original prompt',
        category: 'RCA',
        difficulty: 'Medium',
      }, () => {});
    `);

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: [evalPath], testCaseIds: [] },
    ];

    const first = await resolveTestCaseSources(sources, storage);
    const firstHash = first.testCases[0].sourceHash;

    // V2 — different prompt changes the hash
    fs.writeFileSync(evalPath, `
      const { test } = require('${requirePath}');
      test('Versioned Case', {
        prompt: 'Updated prompt v2',
        category: 'RCA',
        difficulty: 'Medium',
      }, () => {});
    `);

    // Clear module cache so re-import works
    delete require.cache[evalPath];

    const second = await resolveTestCaseSources(sources, storage);
    expect(second.testCases[0].sourceHash).not.toBe(firstHash);
  });

  it('handles multiple test cases in a single file', async () => {
    const evalFile = writeEvalFile('multi.eval.js', `
      const { test } = require('${path.resolve(__dirname, '../../../lib/testCases/define')}');

      test('Multi-1', {
        prompt: 'First prompt',
        category: 'RCA',
        difficulty: 'Easy',
      }, () => {});

      test('Multi-2', {
        prompt: 'Second prompt',
        category: 'RCA',
        difficulty: 'Hard',
      }, () => {});
    `);

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: [evalFile], testCaseIds: [] },
    ];

    const result = await resolveTestCaseSources(sources, storage);

    expect(result.testCases).toHaveLength(2);
    expect(result.evaluateFnMap.size).toBe(2);
    expect(result.testCases[0].name).toBe('Multi-1');
    expect(result.testCases[1].name).toBe('Multi-2');
  });

  it('deduplicates code-imported test cases with other sources', async () => {
    const evalFile = writeEvalFile('dedup.eval.js', `
      const { test } = require('${path.resolve(__dirname, '../../../lib/testCases/define')}');

      test('Dedup Case', {
        prompt: 'What happened?',
        category: 'RCA',
        difficulty: 'Medium',
      }, () => {});
    `);

    const firstSources: TestCaseSource[] = [
      { type: 'code-import', filenames: [evalFile], testCaseIds: [] },
    ];
    const first = await resolveTestCaseSources(firstSources, storage);
    const tcId = first.testCases[0].id;

    const combinedSources: TestCaseSource[] = [
      { type: 'test-case-ids', ids: [tcId] },
      { type: 'code-import', filenames: [evalFile], testCaseIds: [] },
    ];
    const combined = await resolveTestCaseSources(combinedSources, storage);

    expect(combined.testCases).toHaveLength(1);
    expect(combined.deduplicatedCount).toBe(1);
  });
});
