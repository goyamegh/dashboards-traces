/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for ContextValueView — replaces the Test Case detail page's
 * raw, truncated `{ctx.value.slice(0, 100)}...` context rendering with a
 * pretty-printed, syntax-highlighted, untruncated block for JSON context
 * items (and a plain untruncated block for non-JSON ones).
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextValueView } from '@/components/evals3/ContextValueView';

const h = React.createElement;

describe('ContextValueView — JSON context items', () => {
  const jsonValue = JSON.stringify({
    appId: 'explore',
    timeRange: { from: 'now-15m', to: 'now' },
  });

  it('renders the title and a pretty-printed, syntax-highlighted block by default (expanded)', () => {
    render(h(ContextValueView, { title: 'Query context', value: jsonValue }));

    expect(screen.getByText('Query context')).toBeTruthy();
    expect(screen.getByTestId('context-value-toggle').getAttribute('aria-expanded')).toBe('true');

    const pretty = screen.getByTestId('context-value-pretty');
    // Reformatted (not the raw one-liner) and untruncated.
    expect(pretty.textContent).not.toBe(jsonValue);
    expect(pretty.textContent).toContain('"appId"');
    expect(pretty.textContent).toContain('"now-15m"');

    // Prism syntax highlighting actually ran (emits `.token` spans).
    expect(pretty.querySelectorAll('.token').length).toBeGreaterThan(0);

    // JSON badge shown.
    expect(screen.getByText('JSON')).toBeTruthy();
  });

  it('does not truncate large JSON payloads the way the old slice(0, 100) did', () => {
    const big = JSON.stringify({
      appId: 'explore',
      filters: Array.from({ length: 30 }, (_, i) => `filter-value-${i}`),
    });
    render(h(ContextValueView, { title: 'Big context', value: big }));

    const pretty = screen.getByTestId('context-value-pretty');
    expect(pretty.textContent).toContain('filter-value-29');
    expect(pretty.textContent).not.toContain('…');
  });

  it('collapses and re-expands on toggle click', () => {
    render(h(ContextValueView, { title: 'Query context', value: jsonValue }));

    const toggle = screen.getByTestId('context-value-toggle');
    expect(screen.queryByTestId('context-value-pretty')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('context-value-pretty')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByTestId('context-value-pretty')).toBeTruthy();
  });

  it('honors defaultOpen=false', () => {
    render(h(ContextValueView, { title: 'Query context', value: jsonValue, defaultOpen: false }));
    expect(screen.getByTestId('context-value-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('context-value-pretty')).toBeNull();
  });
});

describe('ContextValueView — non-JSON context items', () => {
  it('renders full, untruncated plain text with no JSON badge or highlighting', () => {
    const longText = `Alert fired: web-server-01 CPU > 90%. ${'x'.repeat(150)} END-OF-TEXT`;
    render(h(ContextValueView, { title: 'Alert note', value: longText }));

    expect(screen.queryByText('JSON')).toBeNull();
    const plain = screen.getByTestId('context-value-plain');
    expect(plain.textContent).toBe(longText);
    expect(plain.textContent).toContain('END-OF-TEXT'); // proves no truncation
    expect(plain.querySelectorAll('.token').length).toBe(0); // no highlighting attempted
  });

  it('falls back to plain rendering for malformed JSON-looking text', () => {
    const malformed = '{"appId":"explore","timeRange":';
    render(h(ContextValueView, { title: 'Broken', value: malformed }));

    expect(screen.queryByTestId('context-value-pretty')).toBeNull();
    expect(screen.getByTestId('context-value-plain').textContent).toBe(malformed);
  });
});
