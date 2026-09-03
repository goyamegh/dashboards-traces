/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared cache for the comparison page's hover-preview of a test case's
 * input prompt.
 *
 * WHY `getVersions()`, not `getById()`: `GET /api/storage/test-cases/:id`
 * (asyncTestCaseStorage.getById) always comes back with `versions: []` —
 * the client-side `toTestCase()` conversion deliberately leaves version
 * history out of that response ("Versions fetched separately if needed",
 * services/storage/asyncTestCaseStorage.ts). The ONLY endpoint that returns
 * per-version content (including the historical `initialPrompt` a run may
 * have actually used) is `GET /api/storage/test-cases/:id/versions`
 * (`asyncTestCaseStorage.getVersions`). So the hover's data source is that
 * endpoint, not the "current test case" one TaskSection already fetches for
 * its own body — the two calls answer genuinely different questions
 * (current metadata vs. versioned content), which is also why there's no
 * "reuse TaskSection's already-fetched doc" shortcut for CONTENT (its
 * `testCase.versions` is always `[]` too).
 *
 * WHY module-level (not React state / context): the comparison table can
 * render dozens of case rows, each with its own hyperlink → hover trigger.
 * Sweeping the mouse across the column would otherwise fire a
 * `GET /api/storage/test-cases/:id/versions` per row on every hover, even
 * for the SAME test case referenced from two different link sites (the row
 * link and the deep-dive's "View full test case" link both use the same
 * id). A single module-level `Map<id, Promise<TestCaseVersion[]>>` shared by
 * every hover trigger on the page guarantees at most one in-flight/resolved
 * fetch per id, regardless of how many components mount or how many times
 * the same case is hovered.
 *
 * Keyed by test-case id ONLY, not id+version: the endpoint has no way to
 * request a single version cheaply in a way that's worth a separate cache
 * slot — `getVersions()` returns the ENTIRE version history in one response,
 * which answers a hover for ANY version of that case. `selectPromptForVersion`
 * below picks the right snapshot out of the single cached array. Caching per
 * (id, version) would only cost extra memory for no extra correctness, since
 * a second version of the same id never needs a second network request.
 */

import { asyncTestCaseStorage } from '@/services/storage';
import type { TestCaseVersion } from '@/types';

const cache = new Map<string, Promise<TestCaseVersion[]>>();

/**
 * Fetch (or reuse a cached/in-flight fetch of) the full version history for
 * a hover preview. Network/storage errors resolve to `[]` for the CALLER
 * (a failed lookup should render a graceful "couldn't load" state, never
 * throw during render) but are deliberately NOT cached as a success value:
 * caching a rejected fetch as a permanent `[]` would "poison" that test
 * case's hover for the rest of the session after one transient failure
 * (a 500, a network blip). On rejection the cache entry is evicted (if it's
 * still the SAME pending entry — a concurrent caller may have already
 * replaced it) so the NEXT hover retries instead of repeating the same
 * empty result forever.
 */
export function fetchTestCaseVersionsForHover(testCaseId: string): Promise<TestCaseVersion[]> {
  let pending = cache.get(testCaseId);
  if (!pending) {
    pending = asyncTestCaseStorage.getVersions(testCaseId);
    pending.catch(() => {
      if (cache.get(testCaseId) === pending) cache.delete(testCaseId);
    });
    cache.set(testCaseId, pending);
  }
  return pending.catch(() => []);
}

/** Test-only: reset the module-level cache between test cases. */
export function __resetTestCasePromptCacheForTests(): void {
  cache.clear();
}

/** Test-only: how many distinct ids currently hold a cache entry. */
export function __testCasePromptCacheSizeForTests(): number {
  return cache.size;
}

export interface ResolvedHoverPrompt {
  /** The initial prompt text for the resolved version, if the test case has one at all. */
  initialPrompt?: string;
  /** The version number the prompt text above actually came from. */
  versionUsed?: number;
  /** True when a specific `wantedVersion` was requested but could not be found — the
   *  content shown is a fallback (the latest known version), not a snapshot exact-match. */
  isFallbackVersion: boolean;
}

/**
 * Versioned correctness: a comparison row/report was produced by running a
 * SPECIFIC captured version of the test case (`report.testCaseVersion`),
 * which is not necessarily the test case's current content — the case may
 * have been edited since that run (same principle as the run-resume
 * snapshotting: a report always reflects what was actually asked, not
 * today's edit). Given the version history and the version the run used,
 * resolve to the input prompt AS IT WAS AT THAT VERSION, falling back to
 * the latest captured version only when the specific one can't be found
 * (e.g. version history was pruned, the fetch failed, or no version was
 * known at all).
 */
export function selectPromptForVersion(
  versions: TestCaseVersion[] | null | undefined,
  wantedVersion?: number | string,
): ResolvedHoverPrompt {
  if (!versions || versions.length === 0) return { isFallbackVersion: false };

  const wanted = wantedVersion !== undefined && wantedVersion !== null && wantedVersion !== ''
    ? Number(wantedVersion)
    : undefined;

  if (wanted !== undefined && !Number.isNaN(wanted)) {
    const match = versions.find((v) => v.version === wanted);
    if (match) {
      return { initialPrompt: match.initialPrompt, versionUsed: match.version, isFallbackVersion: false };
    }
  }

  const latest = versions.reduce((max, v) => (v.version > max.version ? v : max), versions[0]);
  return {
    initialPrompt: latest.initialPrompt,
    versionUsed: latest.version,
    isFallbackVersion: wanted !== undefined && !Number.isNaN(wanted),
  };
}
