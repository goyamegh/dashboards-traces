/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the hover-preview data hook. Complements
 * testCasePromptCache.test.ts (which proves the module-level cache dedupes
 * fetches by id) by proving the REACT SIDE of "no fetch storms on row
 * sweep": a component re-rendering with `active` flipping true → false →
 * true again (which is what happens if a user's pointer clips a link on the
 * way across a row without lingering — Radix's `onOpenChange` never fires
 * `true` for that, but if it somehow did) must not re-fetch once the cache
 * already has an answer.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useTestCasePromptPreview } from '@/hooks/useTestCasePromptPreview';
import { __resetTestCasePromptCacheForTests } from '@/services/comparison/testCasePromptCache';
import type { TestCaseVersion } from '@/types';

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getVersions: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { asyncTestCaseStorage } = require('@/services/storage');

const VERSIONS: TestCaseVersion[] = [
  { version: 1, createdAt: '2026-01-01T00:00:00Z', initialPrompt: 'hello', context: [] },
];

describe('useTestCasePromptPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetTestCasePromptCacheForTests();
  });

  it('does nothing while inactive (never fetches before the hover actually opens)', () => {
    const { result } = renderHook(() => useTestCasePromptPreview('tc-1', false));
    expect(result.current).toEqual({ loading: false, versions: [], error: false });
    expect(asyncTestCaseStorage.getVersions).not.toHaveBeenCalled();
  });

  it('fetches once active, and resolves with the version history', async () => {
    asyncTestCaseStorage.getVersions.mockResolvedValue(VERSIONS);
    const { result } = renderHook(() => useTestCasePromptPreview('tc-1', true));

    await waitFor(() => expect(result.current.versions).toEqual(VERSIONS));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(1);
  });

  it('re-activating (hover, leave, hover again) does not re-fetch — the cache already has the answer', async () => {
    asyncTestCaseStorage.getVersions.mockResolvedValue(VERSIONS);
    const { result, rerender } = renderHook(
      ({ active }) => useTestCasePromptPreview('tc-1', active),
      { initialProps: { active: true } }
    );
    await waitFor(() => expect(result.current.versions).toEqual(VERSIONS));

    rerender({ active: false });
    rerender({ active: true });
    rerender({ active: false });
    rerender({ active: true });

    await waitFor(() => expect(result.current.versions).toEqual(VERSIONS));
    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(1);
  });

  it('multiple hover triggers for the SAME id (two link sites, both active) still fetch once', async () => {
    asyncTestCaseStorage.getVersions.mockResolvedValue(VERSIONS);
    const first = renderHook(() => useTestCasePromptPreview('tc-1', true));
    const second = renderHook(() => useTestCasePromptPreview('tc-1', true));

    await waitFor(() => expect(first.result.current.versions).toEqual(VERSIONS));
    await waitFor(() => expect(second.result.current.versions).toEqual(VERSIONS));

    expect(asyncTestCaseStorage.getVersions).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch surfaces error=true and versions=[], without throwing', async () => {
    asyncTestCaseStorage.getVersions.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useTestCasePromptPreview('tc-1', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.versions).toEqual([]);
    expect(result.current.error).toBe(true);
  });

  it('the id changing while a fetch is in flight does not apply the STALE id\'s result to the new id (unmount-cleanup guard)', async () => {
    let resolveA: (v: TestCaseVersion[]) => void;
    const pendingA = new Promise<TestCaseVersion[]>((resolve) => { resolveA = resolve; });
    const versionsB: TestCaseVersion[] = [{ version: 9, createdAt: '2026-02-01T00:00:00Z', initialPrompt: 'b', context: [] }];

    asyncTestCaseStorage.getVersions.mockImplementation((id: string) =>
      id === 'tc-a' ? pendingA : Promise.resolve(versionsB)
    );

    const { result, rerender } = renderHook(
      ({ id }) => useTestCasePromptPreview(id, true),
      { initialProps: { id: 'tc-a' } }
    );

    // Switch to a different id BEFORE tc-a's fetch resolves — the effect's
    // cleanup must mark the tc-a run's callback cancelled so it can never
    // clobber tc-b's state once it finally settles.
    rerender({ id: 'tc-b' });
    await waitFor(() => expect(result.current.versions).toEqual(versionsB));

    // Now let the stale tc-a fetch resolve — must NOT overwrite tc-b's state.
    resolveA!([{ version: 1, createdAt: '2026-01-01T00:00:00Z', initialPrompt: 'a', context: [] }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.versions).toEqual(versionsB);
  });
});
