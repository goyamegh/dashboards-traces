/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for RawEventsPanel (Scope A theming fix).
 *
 * The fix replaced hardcoded bg-gray and text-gray classes with theme
 * tokens (bg-card, bg-muted, text-muted-foreground, etc.) across the panel
 * shell, the search box, and the per-event-type badge helper. These tests
 * render the real component (no mocking) so every one of those lines
 * actually executes, and assert the token classes are present on the DOM.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { RawEventsPanel } from '@/components/RawEventsPanel';

function makeEvent(type: string | undefined, extra: Record<string, any> = {}) {
  return { type, ...extra } as any;
}

describe('RawEventsPanel', () => {
  it('renders the panel shell with theme-token classes (not hardcoded grays)', () => {
    const { container } = render(
      React.createElement(RawEventsPanel, { events: [makeEvent('RUN_STARTED', { runId: 'run-abc12345' })] })
    );

    const shell = container.querySelector('.bg-card');
    expect(shell).toBeTruthy();
    expect(shell?.className).toContain('border-border');
    expect(container.querySelector('.bg-gray-900')).toBeNull();

    // Search input picks up bg-background/text-foreground tokens.
    const input = screen.getByPlaceholderText('Search events...');
    expect(input.className).toContain('bg-background');
    expect(input.className).toContain('text-foreground');
  });

  it('colors every known event-type badge with a themed (non hardcoded-gray) class', () => {
    const events = [
      makeEvent(undefined),
      makeEvent('RUN_ERROR', { message: 'boom' }),
      makeEvent('TOOL_CALL_START', { toolCallName: 'search' }),
      makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }),
      makeEvent('RUN_FINISHED'),
      makeEvent('ACTIVITY_SNAPSHOT', { content: { title: 'Working' } }),
      makeEvent('STATE_SNAPSHOT'), // matches none of the known keywords -> falls through to the neutral default
    ];
    const { container } = render(React.createElement(RawEventsPanel, { events }));

    const badges = container.querySelectorAll('span.font-semibold');
    expect(badges.length).toBe(events.length);

    // Unknown/undefined type -> neutral muted tokens.
    expect(badges[0].className).toContain('text-muted-foreground');
    expect(badges[0].className).toContain('bg-muted');

    // A truthy type that matches none of the known keywords falls through to
    // the same neutral tokens (the final `return neutral;` branch).
    expect(badges[6].className).toContain('text-muted-foreground');
    expect(badges[6].className).toContain('bg-muted');

    // Each badge for a *known* type uses a token-based (light+dark) pairing;
    // none of them should regress to the old gray-100/gray-800 pairing that
    // broke in dark mode. The neutral badges (index 0 and 6) have no dark:
    // counterpart by design (it's a flat muted token), so skip them.
    Array.from(badges).slice(1, 6).forEach((badge) => {
      expect(badge.className).toMatch(/dark:/);
      expect(badge.className).not.toMatch(/dark:bg-gray-800/);
    });
  });

  it('expand all / collapse all toggles event rows without hardcoded gray-950 classes', () => {
    const events = [
      makeEvent('TOOL_CALL_START', { toolCallName: 'search' }),
      makeEvent('TOOL_CALL_RESULT', { content: 'result body' }),
    ];
    const { container } = render(React.createElement(RawEventsPanel, { events }));

    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }));
    expect(container.querySelectorAll('pre').length).toBe(events.length);
    expect(container.querySelector('.bg-gray-950')).toBeNull();
    // Expanded rows use the token background instead.
    expect(container.querySelector('.bg-background')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }));
    expect(container.querySelectorAll('pre').length).toBe(0);
  });

  it('filters events by search term and shows the themed empty state when nothing matches', () => {
    const events = [makeEvent('TOOL_CALL_START', { toolCallName: 'search_logs' })];
    render(React.createElement(RawEventsPanel, { events }));

    const input = screen.getByPlaceholderText('Search events...');
    fireEvent.change(input, { target: { value: 'no-such-event-xyz' } });

    expect(screen.getByText('No events match your search')).toBeTruthy();
    expect(screen.getByText('No events match your search').className).toContain('text-muted-foreground');
  });
});
