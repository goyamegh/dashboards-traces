/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for the shadcn Tooltip primitive under both themes (Scope A
 * theming fix, codecov/patch #219 follow-up).
 *
 * The fix replaced TooltipContent's hardcoded `bg-gray-900 dark:bg-gray-800`
 * / `text-white` / `fill-gray-900 dark:fill-gray-800` with theme tokens
 * (`bg-popover`, `text-popover-foreground`, `fill-popover`) so the tooltip's
 * background and text contrast flip correctly between themes instead of
 * staying a fixed near-black regardless of theme. These tests render the
 * real Radix tooltip (no mocking) with `defaultOpen` to skip the hover
 * delay, and assert the rendered content/arrow use the token classes in
 * both a light and a dark document root.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// jsdom has no ResizeObserver, but Radix's Tooltip (via @radix-ui/react-use-size)
// observes its content node's size on mount. Stub it out (mirrors the
// IntersectionObserver stub pattern in ComparisonScoreboard.zeroDelta.render.test.ts).
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(global as any).ResizeObserver = MockResizeObserver;

function renderTooltip() {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        Tooltip,
        { defaultOpen: true },
        React.createElement(TooltipTrigger, null, 'hover me'),
        React.createElement(TooltipContent, null, 'tooltip body')
      )
    )
  );
}

describe('Tooltip theme tokens (both themes)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it.each([false, true])('uses bg-popover/text-popover-foreground content classes (dark class on root = %s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { baseElement } = renderTooltip();

    // Radix renders the visible content AND a visually-hidden role="tooltip"
    // accessibility announcer with the same text; querying by our own token
    // class (rather than by text) unambiguously targets the real content node.
    const content = baseElement.querySelector('[class*="bg-popover"]') as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.className).toContain('bg-popover');
    expect(content.className).toContain('text-popover-foreground');
    // Old regression: a fixed near-black background regardless of theme.
    expect(content.className).not.toMatch(/bg-gray-900/);
    expect(content.className).not.toMatch(/\btext-white\b/);
  });

  it.each([false, true])('arrow uses fill-popover, not the hardcoded gray pairing (dark class on root = %s)', (dark) => {
    if (dark) document.documentElement.classList.add('dark');
    const { baseElement } = renderTooltip();

    const arrow = baseElement.querySelector('svg[class*="fill-"]');
    expect(arrow).toBeTruthy();
    expect(arrow?.getAttribute('class')).toContain('fill-popover');
    expect(arrow?.getAttribute('class')).not.toMatch(/fill-gray-900/);
  });

  it('content classes are identical whether or not the root has the dark class (theme handled by CSS, not JS)', () => {
    document.documentElement.classList.remove('dark');
    const light = renderTooltip();
    const lightClass = (light.baseElement.querySelector('[class*="bg-popover"]') as HTMLElement).className;
    light.unmount();

    document.documentElement.classList.add('dark');
    const dark = renderTooltip();
    const darkClass = (dark.baseElement.querySelector('[class*="bg-popover"]') as HTMLElement).className;

    expect(darkClass).toBe(lightClass);
  });
});
