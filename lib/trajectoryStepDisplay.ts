/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { TrajectoryStep } from '@/types';

/**
 * Legacy prefix stamped by older producers (services/traces/spansToTrajectory.ts,
 * pre owner-papercut fix) that echoed the user's prompt as a `thinking` step
 * instead of giving it its own `'user'` step type. Producers no longer emit
 * this shape, but old persisted reports still have it.
 */
const LEGACY_USER_PREFIX = 'User: ';

/**
 * Re-derive the intended `user` step for one specific, unambiguous legacy
 * shape: a `thinking` step whose content starts with the literal `User: `
 * echo prefix. We can't retroactively rewrite stored reports, so every
 * surface that renders or compares trajectories (the Test Case Output tab,
 * side-by-side comparison views, and the trajectory diff/similarity engine)
 * calls this at read time instead of leaving old reports permanently
 * mislabeled — and, just as importantly, so an old-shape report and a
 * freshly-run new-shape report showing the identical prompt don't register
 * as a false "modified"/"added+removed" diff purely because of the step's
 * `type` and `content` prefix.
 *
 * Deliberately NOT restricted to index 0: the old producers emitted this
 * shape for every user turn in a multi-turn session, not just the opening
 * one, so restricting the check to the first step would leave later turns
 * in old reports mislabeled. The exact-prefix match is a strong, specific
 * signal (a real chain-of-thought paragraph starting with the literal
 * string "User: ") so the false-positive risk of checking every step is
 * low and no worse than the risk already accepted for the first step.
 */
export function normalizeLegacyUserStep(step: TrajectoryStep): TrajectoryStep {
  if (step.type === 'thinking' && step.content.startsWith(LEGACY_USER_PREFIX)) {
    return { ...step, type: 'user', content: step.content.slice(LEGACY_USER_PREFIX.length) };
  }
  return step;
}

/** Apply {@link normalizeLegacyUserStep} across a full trajectory. */
export function normalizeTrajectorySteps(steps: TrajectoryStep[]): TrajectoryStep[] {
  return steps.map(normalizeLegacyUserStep);
}
