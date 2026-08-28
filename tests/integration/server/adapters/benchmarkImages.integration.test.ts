/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: FileStorageModule benchmark-image operations.
 *
 * Pins the content-addressed invariants the dedup design relies on:
 *   - create is find-or-create keyed on digest (same digest → same doc,
 *     tags/createdAt preserved — never a duplicate)
 *   - images never leak into the benchmarks list/detail (docType isolation)
 *   - evaluationRuns.list({ imageDigest }) returns exactly the runs stamped
 *     with that digest (the comparable set)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { buildImageDoc } from '@/lib/benchmarkImage';
import type { EvaluationRun } from '@/types';

describe('FileStorageModule images (integration)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-image-test-'));
    storage = new FileStorageModule(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const testCases = [
    { id: 'tc-1', name: 'tc-one', initialPrompt: 'Do X', expectedOutcomes: ['X done'] },
    { id: 'tc-2', name: 'tc-two', initialPrompt: 'Do Y', expectedOutcomes: ['Y done'] },
  ];

  it('create is find-or-create: same digest never mints a second doc', async () => {
    const doc = buildImageDoc({ testCases, evalConditions: { evaluatorId: 'e1' }, tags: ['t1'] });
    const created = await storage.images.create(doc);
    expect(created.digest).toBe(doc.digest);

    // Second create with same content: returns the EXISTING doc (tags kept)
    const again = await storage.images.create(
      buildImageDoc({ testCases, evalConditions: { evaluatorId: 'e1' } })
    );
    expect(again.id).toBe(created.id);
    expect(again.tags).toEqual(['t1']); // original tags preserved, not overwritten
    expect(again.createdAt).toBe(created.createdAt);

    const all = await storage.images.getAll();
    expect(all.items.filter((i) => i.digest === doc.digest)).toHaveLength(1);
  });

  it('different eval conditions produce a different image', async () => {
    const doc2 = buildImageDoc({ testCases, evalConditions: { evaluatorId: 'e2' } });
    await storage.images.create(doc2);
    const all = await storage.images.getAll();
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const digests = new Set(all.items.map((i) => i.digest));
    expect(digests.size).toBe(all.items.length); // all unique — digest IS identity
  });

  it('images never surface in the benchmarks list or detail', async () => {
    const image = buildImageDoc({ testCases, evalConditions: { judgeModelId: 'sonnet' } });
    await storage.images.create(image);

    const benchmarks = await storage.benchmarks.getAll();
    expect(benchmarks.items.find((b: any) => b.docType === 'benchmark-image')).toBeUndefined();

    const byId = await storage.benchmarks.getById(image.id);
    expect(byId).toBeNull();
  });

  it('update mutates only tags/lastRunAt (content is identity)', async () => {
    const doc = buildImageDoc({ testCases: [testCases[0]] });
    await storage.images.create(doc);
    const updated = await storage.images.update(doc.digest, {
      tags: ['coding:v1'],
      lastRunAt: '2026-01-01T00:00:00.000Z',
    });
    expect(updated.tags).toEqual(['coding:v1']);
    expect(updated.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
    expect(updated.digest).toBe(doc.digest);
    expect(updated.testCaseCount).toBe(1);
  });

  it('evaluationRuns.list filters by imageDigest (the comparable set)', async () => {
    const doc = buildImageDoc({ testCases, evalConditions: { evaluatorId: 'cmp' } });
    await storage.images.create(doc);

    const mkRun = (id: string, agentKey: string, imageDigest?: string): EvaluationRun =>
      ({
        id,
        docType: 'evaluation-run',
        name: `run ${id}`,
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey,
        modelId: 'm',
        sources: [],
        trigger: 'cli',
        testCaseSnapshots: [],
        results: {},
        ...(imageDigest ? { imageDigest } : {}),
      }) as EvaluationRun;

    await storage.evaluationRuns.create(mkRun('run-pi', 'pi', doc.digest));
    await storage.evaluationRuns.create(mkRun('run-cc', 'claude-code', doc.digest));
    await storage.evaluationRuns.create(mkRun('run-other', 'pi', 'deadbeef'));

    const comparable = await storage.evaluationRuns.list({ imageDigest: doc.digest });
    expect(comparable.items.map((r) => r.id).sort()).toEqual(['run-cc', 'run-pi']);
  });

  it('delete removes the image doc', async () => {
    const doc = buildImageDoc({ testCases: [testCases[1]] });
    await storage.images.create(doc);
    const del = await storage.images.delete(doc.digest);
    expect(del.deleted).toBe(true);
    expect(await storage.images.getByDigest(doc.digest)).toBeNull();
  });
});
