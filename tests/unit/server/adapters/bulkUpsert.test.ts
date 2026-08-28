/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';

describe('bulkUpsert', () => {
  let storage: FileStorageModule;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkupsert-test-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates new test cases when no match exists', async () => {
    const input = [{
      name: 'New Test Case',
      category: 'Security',
      difficulty: 'Hard' as const,
      initialPrompt: 'Find the bug',
      sourceFile: 'evals/security.eval.ts',
      sourceHash: 'abc123',
    }];

    const result = await storage.testCases.bulkUpsert(input);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0].name).toBe('New Test Case');
    expect(result.testCases[0].sourceFile).toBe('evals/security.eval.ts');
    expect(result.testCases[0].sourceHash).toBe('abc123');
  });

  // Eval-source IDE view feature: sourceCode/sourceFileName/sourceLanguage
  // are plain passthrough fields (no schema whitelist on this layer), same
  // as sourceFile/sourceHash above. This locks that in as a regression
  // guard -- a future "tidy up TestCase fields" refactor that adds an
  // explicit allowlist would silently drop the eval source otherwise.
  it('persists sourceCode/sourceFileName/sourceLanguage on create', async () => {
    const input = [{
      name: 'Code SDK Test',
      initialPrompt: 'Analyze the outage',
      sourceFile: 'evals/outage.eval.ts',
      sourceHash: 'hash-v1',
      sourceCode: "import { test } from '@opensearch-project/agent-health';\ntest('a', () => {});\n",
      sourceFileName: 'outage.eval.ts',
      sourceLanguage: 'typescript' as const,
    }];

    const result = await storage.testCases.bulkUpsert(input);

    expect(result.created).toBe(1);
    expect(result.testCases[0].sourceCode).toBe(input[0].sourceCode);
    expect(result.testCases[0].sourceFileName).toBe('outage.eval.ts');
    expect(result.testCases[0].sourceLanguage).toBe('typescript');
  });

  it('updates sourceCode when sourceHash drifts (source edited)', async () => {
    const v1 = [{
      name: 'Drifting Test',
      initialPrompt: 'p',
      sourceFile: 'evals/drift.eval.js',
      sourceHash: 'hash-v1',
      sourceCode: 'test("a", () => {});',
      sourceFileName: 'drift.eval.js',
      sourceLanguage: 'javascript' as const,
    }];
    const first = await storage.testCases.bulkUpsert(v1);
    expect(first.created).toBe(1);

    const v2 = [{
      name: 'Drifting Test',
      initialPrompt: 'p',
      sourceFile: 'evals/drift.eval.js',
      sourceHash: 'hash-v2',
      sourceCode: 'test("a", () => { /* edited */ });',
      sourceFileName: 'drift.eval.js',
      sourceLanguage: 'javascript' as const,
    }];
    const second = await storage.testCases.bulkUpsert(v2);

    expect(second.updated).toBe(1);
    expect(second.testCases[0].id).toBe(first.testCases[0].id);
    expect(second.testCases[0].sourceCode).toBe(v2[0].sourceCode);
  });

  it('skips unchanged test cases (same name + sourceFile + sourceHash)', async () => {
    const input = [{
      name: 'Existing Case',
      category: 'RCA',
      difficulty: 'Medium' as const,
      initialPrompt: 'Analyze the issue',
      sourceFile: 'evals/rca.eval.ts',
      sourceHash: 'hash1',
    }];

    const first = await storage.testCases.bulkUpsert(input);
    expect(first.created).toBe(1);

    const second = await storage.testCases.bulkUpsert(input);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.testCases).toHaveLength(1);
    expect(second.testCases[0].id).toBe(first.testCases[0].id);
  });

  it('updates test cases when sourceHash differs', async () => {
    const input = [{
      name: 'Evolving Case',
      category: 'Security',
      difficulty: 'Easy' as const,
      initialPrompt: 'Original prompt',
      sourceFile: 'evals/evolving.eval.ts',
      sourceHash: 'hash-v1',
    }];

    const first = await storage.testCases.bulkUpsert(input);
    expect(first.created).toBe(1);

    const updated = [{
      ...input[0],
      initialPrompt: 'Updated prompt',
      sourceHash: 'hash-v2',
    }];

    const second = await storage.testCases.bulkUpsert(updated);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(second.testCases).toHaveLength(1);
    expect(second.testCases[0].sourceHash).toBe('hash-v2');
  });

  it('handles mixed create/update/unchanged in a single batch', async () => {
    await storage.testCases.bulkUpsert([
      { name: 'TC1', category: 'RCA', difficulty: 'Easy' as const, initialPrompt: 'P1', sourceFile: 'evals/batch.eval.ts', sourceHash: 'h1' },
      { name: 'TC2', category: 'RCA', difficulty: 'Medium' as const, initialPrompt: 'P2', sourceFile: 'evals/batch.eval.ts', sourceHash: 'h2' },
    ]);

    const result = await storage.testCases.bulkUpsert([
      { name: 'TC1', category: 'RCA', difficulty: 'Easy' as const, initialPrompt: 'P1', sourceFile: 'evals/batch.eval.ts', sourceHash: 'h1' },
      { name: 'TC2', category: 'RCA', difficulty: 'Medium' as const, initialPrompt: 'P2-updated', sourceFile: 'evals/batch.eval.ts', sourceHash: 'h2-new' },
      { name: 'TC3', category: 'Security', difficulty: 'Hard' as const, initialPrompt: 'P3', sourceFile: 'evals/batch.eval.ts', sourceHash: 'h3' },
    ]);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.testCases).toHaveLength(3);
  });

  it('matches by name AND sourceFile (different sourceFile = new)', async () => {
    await storage.testCases.bulkUpsert([
      { name: 'Same Name', category: 'RCA', difficulty: 'Easy' as const, initialPrompt: 'P1', sourceFile: 'evals/file1.eval.ts', sourceHash: 'h1' },
    ]);

    const result = await storage.testCases.bulkUpsert([
      { name: 'Same Name', category: 'RCA', difficulty: 'Easy' as const, initialPrompt: 'P1', sourceFile: 'evals/file2.eval.ts', sourceHash: 'h1' },
    ]);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
  });
});
