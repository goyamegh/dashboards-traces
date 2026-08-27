/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render test for SessionDetailPanel's message-search highlighting
 * (Scope A theming fix).
 *
 * The fix restyled the "active match" highlight (`bg-yellow-400
 * text-black` -> `bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30
 * dark:text-yellow-200`) so the active <mark> keeps readable contrast in
 * both themes, distinct from the (unchanged) inactive-match style. This
 * renders the real panel, types a search term with two matches, and
 * asserts the active vs. inactive <mark> classes.
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SessionDetailPanel } from '@/components/codingAgents/CodingAgentsPage';

// react-markdown/remark-gfm are ESM-only; CodingAgentsPage imports them at
// module scope (for an unrelated markdown tab) so they must be mocked here
// too, same as tests/unit/components/RunDetailsContent.test.ts does.
jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return React.createElement('div', { 'data-testid': 'markdown' }, children);
  };
});
jest.mock('remark-gfm', () => () => {});

// SessionTracesView pulls in @xyflow/react which imports a CSS file jest
// can't parse; mock it out (its tab isn't mounted by default anyway since
// Radix Tabs only mounts the active TabsContent).
jest.mock('@/components/codingAgents/SessionTracesView', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'session-traces-view' }),
}));
jest.mock('@/components/codingAgents/SessionAnnotationsTab', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'session-annotations-tab' }),
}));

// jsdom doesn't implement scrollIntoView; the panel calls it when a search
// match becomes active.
beforeAll(() => {
  (Element.prototype as any).scrollIntoView = jest.fn();
});

const baseSession = {
  agent: 'claude-code',
  session_id: 'sess-1',
  project_path: '/repo/agent-health',
  start_time: '2024-01-01T00:00:00Z',
  duration_minutes: 5,
  user_message_count: 1,
  assistant_message_count: 1,
  input_tokens: 100,
  output_tokens: 50,
  first_prompt: 'fix the theming bug',
  estimated_cost: 0.01,
  session_completed: true,
  tool_counts: {},
} as any;

function mockSessionDetail(text: string) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      session: baseSession,
      messages: [{ role: 'assistant', text }],
    }),
  });
}

describe('SessionDetailPanel search highlighting', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  it('renders the active match in the active highlight class and other matches in the inactive class', async () => {
    mockSessionDetail('bug found: theming bug is fixed');

    await act(async () => {
      render(React.createElement(SessionDetailPanel, { session: baseSession, onClose: jest.fn() }));
    });

    const search = await screen.findByPlaceholderText('Search messages...');

    await act(async () => {
      fireEvent.change(search, { target: { value: 'bug' } });
    });

    await waitFor(() => {
      expect(document.querySelectorAll('mark').length).toBe(2);
    });

    const marks = Array.from(document.querySelectorAll('mark'));
    // First match (global index 0) is active by default.
    expect(marks[0].className).toBe(
      'bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30 dark:text-yellow-200 rounded-sm px-0.5'
    );
    // Second match is not active -> the unchanged, dimmer style.
    expect(marks[1].className).toBe('bg-yellow-200/60 dark:bg-yellow-700/40 rounded-sm px-0.5');

    // Regression guard: the old active style must not reappear.
    marks.forEach((m) => expect(m.className).not.toContain('bg-yellow-400'));
  });

  it('renders no marks when the search term does not match', async () => {
    mockSessionDetail('nothing interesting here');

    await act(async () => {
      render(React.createElement(SessionDetailPanel, { session: baseSession, onClose: jest.fn() }));
    });

    const search = await screen.findByPlaceholderText('Search messages...');
    await act(async () => {
      fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    });

    await waitFor(() => {
      expect(screen.getByText('No messages match your search.')).toBeTruthy();
    });
    expect(document.querySelectorAll('mark').length).toBe(0);
  });
});
