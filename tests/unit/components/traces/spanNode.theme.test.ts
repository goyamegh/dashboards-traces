/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for SpanNode's React Flow handles under both themes (Scope A
 * theming fix, codecov/patch #219 follow-up).
 *
 * The fix replaced the top/bottom `<Handle>` classes' hardcoded
 * `!bg-slate-400 !border-slate-600` with theme tokens
 * (`!bg-muted-foreground/60 !border-border`). The repo's global
 * `@xyflow/react` mock (jest.config.cjs moduleNameMapper) renders `Handle`
 * as `() => null`, discarding props — fine for tests that don't care about
 * this component, but it would hide the exact regression this PR fixes. This
 * file locally overrides just `Handle`/`Position` (via jest.mock, which
 * takes priority over moduleNameMapper for this test file only) so the real
 * className prop SpanNode passes is observable in the DOM.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import type { CategorizedSpan } from '@/types';

jest.mock('@xyflow/react', () => ({
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  Handle: ({ type, position, className }: { type: string; position: string; className?: string }) =>
    React.createElement('div', { 'data-testid': `handle-${type}`, 'data-position': position, className }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SpanNode } = require('@/components/traces/flow/SpanNode');

function makeSpan(overrides: Partial<CategorizedSpan> = {}): CategorizedSpan {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    parentSpanId: undefined,
    name: 'do_thing',
    startTime: '2024-01-01T00:00:00.000Z',
    endTime: '2024-01-01T00:00:01.000Z',
    status: 'OK',
    attributes: {},
    category: 'TOOL',
    categoryLabel: 'Tool',
    categoryColor: 'amber',
    categoryIcon: 'Wrench',
    displayName: 'do_thing',
    ...overrides,
  } as unknown as CategorizedSpan;
}

function renderNode(overrides: Partial<CategorizedSpan> = {}) {
  return render(
    React.createElement(SpanNode, {
      data: { span: makeSpan(overrides), totalDuration: 1000 },
      selected: false,
    })
  );
}

describe('SpanNode handle theming (both themes)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it.each([false, true])('target (top) handle uses muted-foreground/border tokens, not hardcoded slate (dark=%s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { getByTestId } = renderNode();

    const handle = getByTestId('handle-target');
    expect(handle.className).toContain('!bg-muted-foreground/60');
    expect(handle.className).toContain('!border-border');
    expect(handle.className).not.toMatch(/slate-400|slate-600/);
  });

  it.each([false, true])('source (bottom) handle uses muted-foreground/border tokens, not hardcoded slate (dark=%s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { getByTestId } = renderNode();

    const handle = getByTestId('handle-source');
    expect(handle.className).toContain('!bg-muted-foreground/60');
    expect(handle.className).toContain('!border-border');
    expect(handle.className).not.toMatch(/slate-400|slate-600/);
  });

  it('handle classNames are identical in light and dark DOM roots (CSS-driven, not JS-branched)', () => {
    document.documentElement.classList.remove('dark');
    const light = renderNode();
    const lightClass = light.getByTestId('handle-target').className;
    light.unmount();

    document.documentElement.classList.add('dark');
    const dark = renderNode();
    const darkClass = dark.getByTestId('handle-target').className;

    expect(darkClass).toBe(lightClass);
  });
});
