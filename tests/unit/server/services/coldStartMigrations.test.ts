/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeMergedLabels,
  migrateCategoryDifficultyToLabels,
  runColdStartMigrations,
  getLastMigrationStats,
} from '@/server/services/coldStartMigrations';
import type { IStorageModule } from '@/server/adapters/types';
import type { TestCase } from '@/types';

function tcDoc(overrides: Partial<TestCase>): TestCase {
  return {
    id: 'tc-1',
    name: 'Test',
    description: '',
    labels: [],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as TestCase;
}

describe('computeMergedLabels', () => {
  it('migrates legacy category + difficulty into labels when neither facet is in labels', () => {
    const tc = tcDoc({ category: 'RCA' as any, difficulty: 'Medium' as any, labels: [] });
    const out = computeMergedLabels(tc);
    expect(out.changed).toBe(true);
    expect(out.labels).toEqual(['category:RCA', 'difficulty:Medium']);
  });

  it('preserves existing labels and appends missing facets', () => {
    const tc = tcDoc({ category: 'RCA' as any, difficulty: 'Easy' as any, labels: ['team:platform'] });
    const out = computeMergedLabels(tc);
    expect(out.changed).toBe(true);
    expect(out.labels).toEqual(['team:platform', 'category:RCA', 'difficulty:Easy']);
  });

  it('returns no-op when labels already cover both facets', () => {
    const tc = tcDoc({
      category: 'RCA' as any,
      difficulty: 'Medium' as any,
      labels: ['category:Security', 'difficulty:Hard'],
    });
    const out = computeMergedLabels(tc);
    expect(out.changed).toBe(false);
    expect(out.labels).toEqual(['category:Security', 'difficulty:Hard']);
  });

  it('returns no-op when neither legacy field nor labels are set', () => {
    const tc = tcDoc({ category: undefined as any, difficulty: undefined as any, labels: [] });
    const out = computeMergedLabels(tc);
    expect(out.changed).toBe(false);
    expect(out.labels).toEqual([]);
  });

  it('migrates only the missing facet when one is already present', () => {
    const tc = tcDoc({
      category: 'RCA' as any,                  // ignored — labels[0] wins
      difficulty: 'Easy' as any,                // missing in labels — added
      labels: ['category:Security'],
    });
    const out = computeMergedLabels(tc);
    expect(out.changed).toBe(true);
    expect(out.labels).toEqual(['category:Security', 'difficulty:Easy']);
  });

  it('migrates subcategory too', () => {
    const tc = tcDoc({
      category: 'RCA' as any,
      difficulty: 'Medium' as any,
      subcategory: 'auth' as any,
      labels: [],
    });
    const out = computeMergedLabels(tc);
    expect(out.labels).toEqual(['category:RCA', 'difficulty:Medium', 'subcategory:auth']);
  });
});

describe('migrateCategoryDifficultyToLabels', () => {
  function mockStorage(items: TestCase[]) {
    const updateCalls: Array<{ id: string; updates: Partial<TestCase> }> = [];
    const storage: Partial<IStorageModule> = {
      testCases: {
        getAll: jest.fn().mockResolvedValueOnce({ items, total: items.length }).mockResolvedValue({ items: [], total: 0 }),
        update: jest.fn().mockImplementation(async (id, updates) => {
          updateCalls.push({ id, updates });
          return { ...items.find(i => i.id === id), ...updates } as TestCase;
        }),
      } as any,
    };
    return { storage: storage as IStorageModule, updateCalls };
  }

  it('updates only test cases that need migration (idempotent on subsequent runs)', async () => {
    const items = [
      tcDoc({ id: 'a', category: 'RCA' as any, difficulty: 'Easy' as any, labels: [] }),
      tcDoc({ id: 'b', category: 'RCA' as any, difficulty: 'Easy' as any, labels: ['category:RCA', 'difficulty:Easy'] }),
      tcDoc({ id: 'c', category: 'Security' as any, difficulty: 'Hard' as any, labels: ['team:sec'] }),
    ];
    const { storage, updateCalls } = mockStorage(items);

    const stat = await migrateCategoryDifficultyToLabels(storage);
    expect(stat.scanned).toBe(3);
    expect(stat.updated).toBe(2);    // a and c need migration
    expect(stat.skipped).toBe(1);    // b already has both facets
    expect(stat.errors).toBe(0);

    expect(updateCalls.map(c => c.id)).toEqual(['a', 'c']);
    expect(updateCalls[0].updates.labels).toEqual(['category:RCA', 'difficulty:Easy']);
    expect(updateCalls[1].updates.labels).toEqual(['team:sec', 'category:Security', 'difficulty:Hard']);
  });

  it('returns 0 updated for a fully-migrated store (no-op)', async () => {
    const items = [
      tcDoc({ id: 'x', labels: ['category:RCA', 'difficulty:Medium'] }),
      tcDoc({ id: 'y', labels: ['category:Security', 'difficulty:Hard'] }),
    ];
    const { storage } = mockStorage(items);
    const stat = await migrateCategoryDifficultyToLabels(storage);
    expect(stat.scanned).toBe(2);
    expect(stat.updated).toBe(0);
    expect(stat.skipped).toBe(2);
  });

  it('records errors per-document without aborting the batch', async () => {
    const items = [
      tcDoc({ id: 'good', labels: [] }),
      tcDoc({ id: 'bad', labels: [] }),
    ];
    const storage: Partial<IStorageModule> = {
      testCases: {
        getAll: jest.fn().mockResolvedValueOnce({ items, total: items.length }).mockResolvedValue({ items: [], total: 0 }),
        update: jest.fn().mockImplementation(async (id) => {
          if (id === 'bad') throw new Error('boom');
          return items.find(i => i.id === id);
        }),
      } as any,
    };

    const stat = await migrateCategoryDifficultyToLabels(storage as IStorageModule);
    expect(stat.scanned).toBe(2);
    expect(stat.updated).toBe(1);
    expect(stat.errors).toBe(1);
    expect(stat.notes![0]).toContain('boom');
  });

  it('records an error when getAll fails', async () => {
    const storage: Partial<IStorageModule> = {
      testCases: {
        getAll: jest.fn().mockRejectedValue(new Error('cluster down')),
        update: jest.fn(),
      } as any,
    };

    const stat = await migrateCategoryDifficultyToLabels(storage as IStorageModule);
    expect(stat.errors).toBe(1);
    expect(stat.notes!.join(' ')).toContain('cluster down');
  });
});

describe('runColdStartMigrations', () => {
  it('runs every migration and exposes results via getLastMigrationStats', async () => {
    const storage: Partial<IStorageModule> = {
      testCases: {
        getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
        update: jest.fn(),
      } as any,
    };
    const stats = await runColdStartMigrations(storage as IStorageModule);
    expect(stats).toHaveLength(1);
    expect(stats[0].name).toBe('category-difficulty-to-labels');

    const last = getLastMigrationStats();
    expect(last).toHaveLength(1);
    expect(last[0].name).toBe('category-difficulty-to-labels');
  });
});
