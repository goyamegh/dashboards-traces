/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeLegacyUserStep, normalizeTrajectorySteps } from '@/lib/trajectoryStepDisplay';
import { TrajectoryStep } from '@/types';

function makeStep(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    id: 'step-1',
    timestamp: Date.now(),
    type: 'thinking',
    content: '',
    ...overrides,
  };
}

describe('normalizeLegacyUserStep', () => {
  it('relabels a legacy thinking step whose content starts with "User: " to type `user`, stripping the prefix', () => {
    const step = makeStep({ type: 'thinking', content: 'User: fix the login bug' });
    const result = normalizeLegacyUserStep(step);
    expect(result.type).toBe('user');
    expect(result.content).toBe('fix the login bug');
  });

  it('relabels regardless of the step\'s position in the trajectory (multi-turn legacy reports)', () => {
    // The function itself is position-agnostic; callers apply it per-step.
    const step = makeStep({ type: 'thinking', content: 'User: a later turn in the conversation' });
    expect(normalizeLegacyUserStep(step).type).toBe('user');
  });

  it('does NOT relabel a genuine thinking step that merely mentions "User" mid-sentence', () => {
    const step = makeStep({ type: 'thinking', content: 'The User asked about mugs, let me search.' });
    const result = normalizeLegacyUserStep(step);
    expect(result.type).toBe('thinking');
    expect(result.content).toBe(step.content);
  });

  it('does NOT touch a step that is already type `user`', () => {
    const step = makeStep({ type: 'user', content: 'fix the login bug' });
    const result = normalizeLegacyUserStep(step);
    expect(result).toBe(step); // same reference — no unnecessary copy
  });

  it('does NOT touch other step types (action/response/tool_result/assistant)', () => {
    for (const type of ['action', 'response', 'tool_result', 'assistant'] as const) {
      const step = makeStep({ type, content: 'User: not actually a user prompt here' });
      expect(normalizeLegacyUserStep(step).type).toBe(type);
    }
  });

  it('does NOT relabel a `tool.blocked_on_user` decision step ("User rejected a tool call")', () => {
    const step = makeStep({ type: 'thinking', content: 'User rejected a tool call (user_temporary)' });
    // No literal "User: " prefix (no colon-space right after "User"), so it stays thinking.
    expect(normalizeLegacyUserStep(step).type).toBe('thinking');
  });
});

describe('normalizeTrajectorySteps', () => {
  it('normalizes every legacy user-prompt step in a full trajectory, leaving the rest untouched', () => {
    const steps: TrajectoryStep[] = [
      makeStep({ id: 's1', type: 'thinking', content: 'User: turn one' }),
      makeStep({ id: 's2', type: 'action', content: 'searched', toolName: 'search' }),
      makeStep({ id: 's3', type: 'thinking', content: 'User: turn two' }),
      makeStep({ id: 's4', type: 'response', content: 'done' }),
    ];

    const normalized = normalizeTrajectorySteps(steps);

    expect(normalized.map(s => s.type)).toEqual(['user', 'action', 'user', 'response']);
    expect(normalized[0].content).toBe('turn one');
    expect(normalized[2].content).toBe('turn two');
  });

  it('returns an empty array for an empty trajectory', () => {
    expect(normalizeTrajectorySteps([])).toEqual([]);
  });
});
