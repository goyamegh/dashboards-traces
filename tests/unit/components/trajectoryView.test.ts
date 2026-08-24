/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for TrajectoryView (Scope A theming fix).
 *
 * The fix added a dark-mode variant to the failed-step color
 * (`text-red-400` -> `text-red-600 dark:text-red-400`) so failed steps stay
 * legible in light mode too. These tests render the real component to
 * exercise both the failed and non-failed color branches.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { TrajectoryView } from '@/components/TrajectoryView';
import { ToolCallStatus, TrajectoryStep } from '@/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children, className }: any) => React.createElement('div', { className, 'data-testid': 'markdown' }, children),
  hasRealMarkdown: () => false,
}));

function makeStep(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    id: 'step-1',
    type: 'action',
    content: 'did a thing',
    ...overrides,
  } as TrajectoryStep;
}

describe('TrajectoryView', () => {
  it('renders the failed-step label in the red text-red-600/dark:text-red-400 color', () => {
    const steps = [makeStep({ id: 'fail-1', type: 'action', status: ToolCallStatus.FAILURE, toolName: 'run_tests' })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText(/action · run_tests/);
    expect(label.className).toContain('text-red-600');
    expect(label.className).toContain('dark:text-red-400');
  });

  it('renders non-failed steps with the per-type color, not the failure red', () => {
    const steps = [makeStep({ id: 'ok-1', type: 'assistant', status: ToolCallStatus.SUCCESS })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText('assistant');
    expect(label.className).toBe('font-semibold text-purple-400');
    expect(label.className).not.toContain('red');
  });

  it('shows the empty state when there are no steps and not loading', () => {
    render(React.createElement(TrajectoryView, { steps: [], loading: false }));
    expect(screen.getByText('No test case output available')).toBeTruthy();
  });

  it('shows the initializing indicator when there are no steps and loading', () => {
    render(React.createElement(TrajectoryView, { steps: [], loading: true }));
    expect(screen.getByText('Initializing agent...')).toBeTruthy();
  });
});
