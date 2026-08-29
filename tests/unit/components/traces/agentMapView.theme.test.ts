/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render test for AgentMapView's React Flow Background/MiniMap theming
 * (Scope A theming fix, codecov/patch #219 follow-up: "add tests for both
 * themes").
 *
 * The fix replaced the Background dot color (`#334155`, a fixed slate hex
 * invisible on a light background) and the MiniMap's `rgba(15, 23, 42, 0.8)`
 * mask + `!bg-slate-900/50 !border-slate-700` classes with CSS-var-driven
 * values (`hsl(var(--border))`, `hsl(var(--background) / 0.8)`,
 * `!bg-card/80 !border !border-border`) so both react to the active theme
 * via the cascade instead of being hardcoded to the dark palette.
 *
 * The repo's global `@xyflow/react` mock (jest.config.cjs moduleNameMapper)
 * renders `ReactFlow`/`Background`/`MiniMap` as `() => null` and drops all
 * props — appropriate for tests that don't care about this library, but it
 * would hide exactly the regression this PR fixes. This file locally
 * overrides those three (jest.mock takes priority over moduleNameMapper for
 * this file only) so the real prop values AgentMapView passes are
 * observable in the DOM, then asserts them under both a light and a dark
 * document root.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import type { Span, TimeRange } from '@/types';

jest.mock('@xyflow/react/dist/style.css', () => ({}), { virtual: true });
jest.mock('@xyflow/react', () => ({
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  useNodesState: (initial: unknown[]) => [initial, jest.fn(), jest.fn()],
  useEdgesState: (initial: unknown[]) => [initial, jest.fn(), jest.fn()],
  ReactFlow: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'reactflow' }, children),
  Background: (props: { color?: string; variant?: string }) =>
    React.createElement('div', { 'data-testid': 'rf-background', 'data-color': props.color, 'data-variant': props.variant }),
  MiniMap: (props: { maskColor?: string; className?: string }) =>
    React.createElement('div', { 'data-testid': 'rf-minimap', 'data-mask-color': props.maskColor, className: props.className }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentMapView } = require('@/components/traces/AgentMapView');

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'agent.run',
    startTime: '2024-01-01T00:00:00.000Z',
    endTime: '2024-01-01T00:00:02.000Z',
    status: 'OK',
    attributes: { 'gen_ai.operation.name': 'chat' },
    children: [],
    ...overrides,
  };
}

const timeRange: TimeRange = { startTime: 0, endTime: 2000, duration: 2000 };

function renderMap() {
  return render(
    React.createElement(AgentMapView, {
      spanTree: [makeSpan()],
      timeRange,
      selectedSpan: null,
      onSelectSpan: () => {},
    })
  );
}

describe('AgentMapView Background/MiniMap theming (both themes)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it.each([false, true])('Background uses the border CSS var, not a hardcoded slate hex (dark=%s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { getByTestId } = renderMap();

    const bg = getByTestId('rf-background');
    expect(bg.getAttribute('data-color')).toBe('hsl(var(--border))');
    expect(bg.getAttribute('data-color')).not.toBe('#334155');
  });

  it.each([false, true])('MiniMap uses card/border tokens, not the hardcoded slate overlay (dark=%s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { getByTestId } = renderMap();

    const minimap = getByTestId('rf-minimap');
    expect(minimap.getAttribute('data-mask-color')).toBe('hsl(var(--background) / 0.8)');
    expect(minimap.getAttribute('data-mask-color')).not.toMatch(/rgba\(15, ?23, ?42/);
    expect(minimap.className).toContain('!bg-card/80');
    expect(minimap.className).toContain('!border-border');
    expect(minimap.className).not.toMatch(/slate-900|slate-700/);
  });

  it('Background/MiniMap prop values are identical in light and dark DOM roots (CSS-driven, not JS-branched)', () => {
    document.documentElement.classList.remove('dark');
    const light = renderMap();
    const lightColor = light.getByTestId('rf-background').getAttribute('data-color');
    const lightMask = light.getByTestId('rf-minimap').getAttribute('data-mask-color');
    light.unmount();

    document.documentElement.classList.add('dark');
    const dark = renderMap();
    expect(dark.getByTestId('rf-background').getAttribute('data-color')).toBe(lightColor);
    expect(dark.getByTestId('rf-minimap').getAttribute('data-mask-color')).toBe(lightMask);
  });
});
