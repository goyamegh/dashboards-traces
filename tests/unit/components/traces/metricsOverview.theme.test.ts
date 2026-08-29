/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for MetricsOverview's latency-bucket coloring under both
 * themes (Scope A theming fix, codecov/patch #219 follow-up).
 *
 * The fix appended a `dark:bg-*-400/80` variant to each of
 * `getLatencyColor()`'s five hardcoded `bg-*-500` classes so the latency
 * bars stay visible against the dark card background. These tests render
 * the real component (no mocking — MetricsOverview has no external deps
 * beyond plain UI atoms) and expand it to exercise every branch of the
 * bucket -> color mapping this PR touched.
 */

import * as React from 'react';
import { render, within, fireEvent } from '@testing-library/react';
import { MetricsOverview } from '@/components/traces/MetricsOverview';

function renderExpanded(latencyDistribution: Array<{ label: string; min: number; max: number; count: number }>) {
  const utils = render(
    React.createElement(MetricsOverview, {
      latencyDistribution,
      errorTimeSeries: [],
      requestTimeSeries: [],
      totalRequests: 10,
      totalSpans: 20,
      totalErrors: 0,
      avgLatency: 250,
    })
  );
  // The latency-distribution bars only render once the card is expanded.
  // Scope the query to this render's own container (via `within`) rather
  // than the global `screen` — the test below mounts two instances at once
  // to compare light vs. dark output, which would otherwise collide.
  fireEvent.click(within(utils.container).getByText('Metrics'));
  return utils;
}

describe('MetricsOverview latency bucket colors (both themes)', () => {
  it.each([
    [50, 'bg-green-500', 'dark:bg-green-400/80'],
    [500, 'bg-blue-500', 'dark:bg-blue-400/80'],
    [1000, 'bg-yellow-500', 'dark:bg-yellow-400/80'],
    [5000, 'bg-orange-500', 'dark:bg-orange-400/80'],
    [50000, 'bg-red-500', 'dark:bg-red-400/80'],
  ])('bucket with max=%d gets %s with %s dark variant', (max, lightClass, darkClass) => {
    const { container } = renderExpanded([{ label: 'b', min: 0, max: max as number, count: 3 }]);
    const bar = container.querySelector(`.${lightClass}`);
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain(darkClass);
  });

  it('the light/dark pairing is identical regardless of document.documentElement dark class (CSS-driven, not JS-branched)', () => {
    document.documentElement.classList.remove('dark');
    const { container: withoutDark } = renderExpanded([{ label: 'b', min: 0, max: 50, count: 1 }]);
    const classWithoutDark = withoutDark.querySelector('.bg-green-500')?.className;

    document.documentElement.classList.add('dark');
    const { container: withDark } = renderExpanded([{ label: 'b', min: 0, max: 50, count: 1 }]);
    const classWithDark = withDark.querySelector('.bg-green-500')?.className;
    document.documentElement.classList.remove('dark');

    expect(classWithDark).toBe(classWithoutDark);
  });
});
