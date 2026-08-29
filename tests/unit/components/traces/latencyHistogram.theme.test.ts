/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for LatencyHistogram under both themes (Scope A theming fix,
 * codecov/patch #219 follow-up: "add tests for both themes").
 *
 * Before the fix, `getBarStyle()` read `document.documentElement.classList
 * .contains('dark')` at render time and picked one of two inline-style color
 * tables (light vs. a 0.3-alpha dark table that "disappeared into dark
 * backgrounds" per the PR description). The fix deletes that JS branch
 * entirely in favor of static Tailwind classes carrying both a solid light
 * color and a `dark:` variant, so the cascade — not React — decides which
 * one paints. These tests render the real component (no mocking) with the
 * `dark` class toggled on `document.documentElement` (the mechanism in
 * lib/theme.ts) both on and off, and assert:
 *  - the exact same className is produced in both cases (the isDarkMode
 *    branch is really gone, not just relabeled), and
 *  - that className carries both the light-mode utility and its `dark:`
 *    counterpart for every bucket, including the >6-bucket fallback.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import { LatencyHistogram } from '@/components/traces/LatencyHistogram';

interface Bucket {
  label: string;
  count: number;
  min: number;
  max: number;
}

function makeBuckets(n: number): Bucket[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `bucket-${i}`,
    count: i + 1,
    min: i * 100,
    max: (i + 1) * 100,
  }));
}

function barClassesFor(count: number): string[] {
  const { container } = render(React.createElement(LatencyHistogram, { data: makeBuckets(count) }));
  return Array.from(container.querySelectorAll('[title]')).map((el) => (el as HTMLElement).className);
}

describe('LatencyHistogram (both themes)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('renders identical bar classNames in light and dark mode (no runtime isDarkMode branch)', () => {
    document.documentElement.classList.remove('dark');
    const lightClasses = barClassesFor(6);

    document.documentElement.classList.add('dark');
    const darkClasses = barClassesFor(6);

    expect(darkClasses).toEqual(lightClasses);
  });

  it('each of the 6 known buckets carries both a solid light color and its dark: variant', () => {
    const classes = barClassesFor(6);
    const expected = [
      ['bg-emerald-300', 'dark:bg-emerald-400/80'],
      ['bg-lime-300', 'dark:bg-lime-400/80'],
      ['bg-yellow-300', 'dark:bg-yellow-400/80'],
      ['bg-amber-400', 'dark:bg-amber-400/80'],
      ['bg-orange-400', 'dark:bg-orange-400/80'],
      ['bg-red-400', 'dark:bg-red-400/80'],
    ];
    expected.forEach(([light, dark], i) => {
      expect(classes[i]).toContain(light);
      expect(classes[i]).toContain(dark);
    });
    // Old bug: the dark-mode table used a flat 0.3 alpha overlay with no
    // Tailwind dark: prefix at all — guard against that regressing back in.
    classes.forEach((c) => expect(c).toMatch(/dark:bg-\w+-\d+\/80/));
  });

  it('a 7th (unmapped) bucket falls back to the themed gray pairing, not transparent/invisible', () => {
    const classes = barClassesFor(7);
    expect(classes[6]).toContain('bg-gray-300');
    expect(classes[6]).toContain('dark:bg-gray-400/70');
  });

  it('does not regress to the old rgba(...) inline-style color branching', () => {
    const { container } = render(React.createElement(LatencyHistogram, { data: makeBuckets(3) }));
    const bar = container.querySelector('[title]') as HTMLElement;
    expect(bar.style.backgroundColor).toBe('');
    expect(bar.getAttribute('style') || '').not.toMatch(/rgba?\(/);
  });
});
