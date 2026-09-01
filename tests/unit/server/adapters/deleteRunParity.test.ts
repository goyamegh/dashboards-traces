/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-backend contract test for `IBenchmarkOperations.deleteRun`.
 *
 * The file and OpenSearch storage adapters implement the same interface but
 * are two entirely separate code paths. `deleteRun` previously disagreed
 * across backends (the OpenSearch adapter reported success for ANY run id
 * on an existing benchmark; see server/adapters/opensearch/StorageModule.ts).
 * This test drives BOTH real adapters — a real `FileStorageModule` against a
 * tmp dir, and a real `OpenSearchStorageModule` against a mocked client whose
 * responses mirror the *actual* `@opensearch-project/opensearch` v3.5.1
 * response shape observed against a live cluster (`{ body: { result: … } }`,
 * `result: 'updated'` on a real removal, `result: 'noop'` when the script ran
 * but nothing matched, and a thrown `ResponseError` with `meta.statusCode ===
 * 404` for a missing document) — through the exact same three scenarios and
 * asserts identical return values.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';

jest.mock('@/server/middleware/dataSourceConfig', () => ({
  STORAGE_INDEXES: {
    testCases: 'evals_test_cases',
    benchmarks: 'evals_experiments',
    runs: 'evals_runs',
    analytics: 'evals_analytics',
  },
}));

jest.mock('@/server/services/migrationLock', () => ({
  assertNotMigrating: jest.fn(),
  MigrationInProgressError: class MigrationInProgressError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MigrationInProgressError';
    }
  },
}));

function make404Error() {
  const err = new Error('Not Found') as any;
  err.meta = { statusCode: 404 };
  err.name = 'ResponseError';
  return err;
}

/**
 * Mock OpenSearch client whose `update()` mirrors the real cluster's
 * documented behavior for this method's painless script:
 *  - benchmark exists, runId matches   -> resolves { body: { result: 'updated' } }
 *  - benchmark exists, runId missing   -> resolves { body: { result: 'noop' } }
 *  - benchmark missing                 -> rejects with a 404 ResponseError
 */
function createRealisticMockClient(scenario: 'match' | 'noop' | 'missingBenchmark') {
  const update = jest.fn(async () => {
    if (scenario === 'missingBenchmark') throw make404Error();
    if (scenario === 'match') return { body: { result: 'updated' }, statusCode: 200 };
    return { body: { result: 'noop' }, statusCode: 200 };
  });
  return {
    search: jest.fn(),
    get: jest.fn(),
    index: jest.fn(),
    delete: jest.fn(),
    deleteByQuery: jest.fn(),
    update,
    cluster: { health: jest.fn() },
    cat: { indices: jest.fn() },
  };
}

describe('deleteRun cross-backend parity (file vs OpenSearch)', () => {
  let tmpDir: string;
  let fileMod: FileStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-parity-'));
    fileMod = new FileStorageModule(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function makeOpenSearchAdapter(scenario: 'match' | 'noop' | 'missingBenchmark') {
    const { OpenSearchStorageModule } = await import('@/server/adapters/opensearch/StorageModule');
    const mockSessionMetadata = { get: jest.fn(), put: jest.fn(), list: jest.fn() };
    const client = createRealisticMockClient(scenario);
    return { mod: new OpenSearchStorageModule(client as any, mockSessionMetadata as any), client };
  }

  it('existing benchmark + existing run: both backends return true', async () => {
    const benchmark = await fileMod.benchmarks.create({ name: 'parity-1' });
    await fileMod.benchmarks.addRun(benchmark.id, { id: 'run-1', status: 'pending' } as any);

    const fileResult = await fileMod.benchmarks.deleteRun(benchmark.id, 'run-1');
    expect(fileResult).toBe(true);

    const { mod: osMod } = await makeOpenSearchAdapter('match');
    const osResult = await osMod.benchmarks.deleteRun('bench-1', 'run-1');
    expect(osResult).toBe(true);

    expect(osResult).toBe(fileResult);
  });

  it('existing benchmark + missing run: both backends return false', async () => {
    const benchmark = await fileMod.benchmarks.create({ name: 'parity-2' });
    await fileMod.benchmarks.addRun(benchmark.id, { id: 'run-1', status: 'pending' } as any);

    const fileResult = await fileMod.benchmarks.deleteRun(benchmark.id, 'run-does-not-exist');
    expect(fileResult).toBe(false);

    const { mod: osMod } = await makeOpenSearchAdapter('noop');
    const osResult = await osMod.benchmarks.deleteRun('bench-1', 'run-does-not-exist');
    expect(osResult).toBe(false);

    expect(osResult).toBe(fileResult);
  });

  it('missing benchmark: both backends return false (never throw)', async () => {
    const fileResult = await fileMod.benchmarks.deleteRun('no-such-benchmark', 'run-1');
    expect(fileResult).toBe(false);

    const { mod: osMod } = await makeOpenSearchAdapter('missingBenchmark');
    const osResult = await osMod.benchmarks.deleteRun('no-such-benchmark', 'run-1');
    expect(osResult).toBe(false);

    expect(osResult).toBe(fileResult);
  });

  it('OpenSearch adapter refuses to assume success on an unrecognized result shape (fail-closed)', async () => {
    // Regression guard for the bug this file exists to prevent: a naive
    // `!== 'noop'` check would treat a missing/renamed `result` field as
    // success. The adapter must instead throw rather than silently report
    // a delete that may not have happened.
    const { OpenSearchStorageModule } = await import('@/server/adapters/opensearch/StorageModule');
    const mockSessionMetadata = { get: jest.fn(), put: jest.fn(), list: jest.fn() };
    const client = {
      search: jest.fn(),
      get: jest.fn(),
      index: jest.fn(),
      delete: jest.fn(),
      deleteByQuery: jest.fn(),
      update: jest.fn(async () => ({ statusCode: 200 })), // no `.body` at all
      cluster: { health: jest.fn() },
      cat: { indices: jest.fn() },
    };
    const osMod = new OpenSearchStorageModule(client as any, mockSessionMetadata as any);

    await expect(osMod.benchmarks.deleteRun('bench-1', 'run-1')).rejects.toThrow(
      /unrecognized OpenSearch update result/,
    );
  });
});
