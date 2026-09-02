/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison page's hover-preview cache/version logic.
 *
 * `fetchTestCaseVersionsForHover` is the one place that guarantees "no fetch
 * storms on row sweep": a mouse hovering N different links that all point at
 * the SAME test case id (e.g. the row link and the deep-dive's "View full
 * test case" link) must trigger exactly one
 * `GET /api/storage/test-cases/:id/versions`, not N.
 *
 * `selectPromptForVersion` is the versioned-correctness piece: a comparison
 * row reflects the version of the test case that a run actually used, which
 * may not be the test case's current content.
 */

import {
  fetchTestCaseVersionsForHover,
  selectPromptForVersion,
  __resetTestCasePromptCacheForTests,
  __testCasePromptCacheSizeForTests,
} from '@/services/comparison/testCasePromptCache';
import type { TestCaseVersion } from '@/types';

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getVersions: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { asyncTestCaseStorage } = require('@/services/storage');

const VERSIONS: TestCaseVersion[] = [
  { version: 1, createdAt: '2026-01-01T00:00:00Z', initialPrompt: 'v1 prompt', context: [] },
  { version: 2, createdAt: '2026-01-02T00:00:00Z', initialPrompt: 'v2 prompt', context: [] },
  { version: 3, createdAt: '2026-01-03T00:00:00Z', initialPrompt: 'v3 prompt (current)', context: [] },
];

describe('fetchTestCaseVersionsForHover (cache)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetTestCasePromptCacheForTests();
  });

  it('fetches once per id even when hovered N times (row-sweep dedup)', async () => {
    asyncTestCaseStorage.getVersions.mockResolvedValue(VERSIONS);

    // Simulate the user hovering the SAME test case's link 5 times across
    // two different link sites on the page.
    const results = await Promise.all([
      fetchTestCaseVersionsForHover('tc-1'),
      fetchTestCaseVersionsForHover('tc-1'),
      fetchTestCaseVersionsForHover('tc-1'),
      fetchTestCaseVersionsForHover('tc-1'),
      fetchTestCaseVersionsForHover('tc-1'),
    ]);

    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(1);
    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledWith('tc-1');
    results.forEach((r) => expect(r).toBe(VERSIONS));
  });

  it('does not share the cache entry across different ids', async () => {
    const versionsA: TestCaseVersion[] = [{ version: 1, createdAt: '2026-01-01T00:00:00Z', initialPrompt: 'a', context: [] }];
    const versionsB: TestCaseVersion[] = [{ version: 1, createdAt: '2026-01-01T00:00:00Z', initialPrompt: 'b', context: [] }];
    asyncTestCaseStorage.getVersions.mockImplementation((id: string) =>
      Promise.resolve(id === 'tc-a' ? versionsA : versionsB)
    );

    const [a, b, aAgain] = await Promise.all([
      fetchTestCaseVersionsForHover('tc-a'),
      fetchTestCaseVersionsForHover('tc-b'),
      fetchTestCaseVersionsForHover('tc-a'),
    ]);

    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(2);
    expect(a).toBe(versionsA);
    expect(b).toBe(versionsB);
    expect(aAgain).toBe(versionsA);
    expect(__testCasePromptCacheSizeForTests()).toBe(2);
  });

  it('resolves to [] (not a rejection) when the fetch fails, and still only fetches once', async () => {
    asyncTestCaseStorage.getVersions.mockRejectedValue(new Error('boom'));

    const [first, second] = await Promise.all([
      fetchTestCaseVersionsForHover('tc-err'),
      fetchTestCaseVersionsForHover('tc-err'),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(1);
  });

  it('a fresh fetch happens again after the cache is reset (e.g. between test cases)', async () => {
    asyncTestCaseStorage.getVersions.mockResolvedValue(VERSIONS);
    await fetchTestCaseVersionsForHover('tc-1');
    __resetTestCasePromptCacheForTests();
    await fetchTestCaseVersionsForHover('tc-1');

    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(2);
  });
});

describe('selectPromptForVersion', () => {
  it('returns nothing for an empty/missing version list', () => {
    expect(selectPromptForVersion([])).toEqual({ isFallbackVersion: false });
    expect(selectPromptForVersion(null)).toEqual({ isFallbackVersion: false });
    expect(selectPromptForVersion(undefined)).toEqual({ isFallbackVersion: false });
  });

  it('picks the CAPTURED version the run used, not the latest content', () => {
    const resolved = selectPromptForVersion(VERSIONS, 1);
    expect(resolved).toEqual({ initialPrompt: 'v1 prompt', versionUsed: 1, isFallbackVersion: false });
  });

  it('picks a middle version correctly (not just first/last)', () => {
    const resolved = selectPromptForVersion(VERSIONS, 2);
    expect(resolved.initialPrompt).toBe('v2 prompt');
    expect(resolved.versionUsed).toBe(2);
  });

  it('accepts the version as a string (as carried by TestCaseRunResult.testCaseVersion)', () => {
    const resolved = selectPromptForVersion(VERSIONS, '1');
    expect(resolved.initialPrompt).toBe('v1 prompt');
    expect(resolved.versionUsed).toBe(1);
  });

  it('falls back to the latest version when no version is specified', () => {
    const resolved = selectPromptForVersion(VERSIONS, undefined);
    expect(resolved).toEqual({
      initialPrompt: 'v3 prompt (current)',
      versionUsed: 3,
      isFallbackVersion: false,
    });
  });

  it('falls back to the latest version (and flags the fallback) when the requested version was not captured', () => {
    const resolved = selectPromptForVersion(VERSIONS, 99);
    expect(resolved.initialPrompt).toBe('v3 prompt (current)');
    expect(resolved.versionUsed).toBe(3);
    expect(resolved.isFallbackVersion).toBe(true);
  });

  it('finds the latest version even when the array is not sorted', () => {
    const shuffled = [VERSIONS[2], VERSIONS[0], VERSIONS[1]];
    const resolved = selectPromptForVersion(shuffled, undefined);
    expect(resolved.versionUsed).toBe(3);
    expect(resolved.initialPrompt).toBe('v3 prompt (current)');
  });

  it('handles a version with no initialPrompt at all (deterministic/code-only test cases)', () => {
    const versions: TestCaseVersion[] = [{ version: 1, createdAt: '2026-01-01T00:00:00Z', context: [] }];
    const resolved = selectPromptForVersion(versions, 1);
    expect(resolved.initialPrompt).toBeUndefined();
    expect(resolved.versionUsed).toBe(1);
  });
});
