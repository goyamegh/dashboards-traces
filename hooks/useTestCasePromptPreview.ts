/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { TestCaseVersion } from '@/types';
import { fetchTestCaseVersionsForHover } from '@/services/comparison/testCasePromptCache';

interface TestCasePromptPreviewState {
  loading: boolean;
  versions: TestCaseVersion[];
  error: boolean;
}

const IDLE: TestCasePromptPreviewState = { loading: false, versions: [], error: false };

/**
 * Lazily loads a test case's version history (for the hover-preview's
 * prompt text) the first time `active` becomes true, and never again for
 * the same id — the dedupe/sharing happens in the module-level cache
 * (`services/comparison/testCasePromptCache`), this hook just subscribes a
 * component to that cache's result.
 *
 * `active` should be the hover/focus primitive's OWN "actually open" state
 * (e.g. Radix Tooltip's `onOpenChange`), not raw pointer-enter — that's what
 * gives us "no fetch storms on row sweep": Radix already suppresses the
 * open transition (and therefore `active`) for a hover that doesn't linger
 * past the open delay, so a mouse sweeping across many rows fetches nothing
 * for cases the user didn't actually pause on.
 */
export function useTestCasePromptPreview(
  testCaseId: string,
  active: boolean,
): TestCasePromptPreviewState {
  const [state, setState] = useState<TestCasePromptPreviewState>(IDLE);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    setState((prev) => (prev.versions.length > 0 ? prev : { ...prev, loading: true }));

    fetchTestCaseVersionsForHover(testCaseId).then((versions) => {
      if (cancelled) return;
      setState({ loading: false, versions, error: versions.length === 0 });
    });

    return () => {
      cancelled = true;
    };
  }, [testCaseId, active]);

  return state;
}
