/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-analysis tests for ComparisonScoreboard.
 *
 * The ComparisonScoreboard replaces VerdictStrip + ComparisonOverlapBanner +
 * the standalone MetricComparisonPanel Collapsible with a single unified sticky
 * band. Follows the source-analysis pattern (evaluatorRemoval, uiPapercuts)
 * since this component requires recharts, IntersectionObserver, and router context.
 *
 * The "Open run" deep-link fix (bottom of this file) IS rendered for real
 * (jsdom + @testing-library/react + a lightweight react-router-dom Link stub
 * + an IntersectionObserver stub) rather than source-grepped, since it's the
 * one behavior in this component with an actual branch (benchmarkId present
 * vs. absent) worth asserting against real DOM output.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf-8');

// jsdom has no IntersectionObserver; the component's scroll-condense effect
// needs a stub so it can mount without throwing.
class MockIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;

// The component only imports `Link` from react-router-dom (no router-context
// hooks) — stub it as a plain anchor so we can assert the rendered `href`
// without mounting a MemoryRouter.
jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) =>
    React.createElement('a', { href: to, ...rest }, children),
}));

describe('ComparisonScoreboard structure', () => {
  let src: string;
  beforeAll(() => { src = read('components/comparison/ComparisonScoreboard.tsx'); });

  it('renders both run rows with A/B badges', () => {
    expect(src).toContain('RunBadgeA');
    expect(src).toContain('RunBadgeB');
    // data-testid uses a template literal: `scoreboard-row-${label}`
    expect(src).toContain('scoreboard-row-${label}');
  });

  it('shows pass-rate delta in the footer row', () => {
    expect(src).toContain('Delta');
    expect(src).toContain('passRateDelta');
    expect(src).toContain("'pp'");
  });

  it('renders a neutral em-dash (not a bare "=") for zero cost/duration/pass-rate delta', () => {
    // Regression: costDelta === 0 and durationDelta === 0 used to render a
    // bare '=' glyph, which reads as an equals-sign typo rather than "no
    // change". Now uses an em dash with a "No change" tooltip, matching the
    // muted-foreground styling already applied for the zero case.
    expect(src).not.toContain("=== 0 ? '='");
    expect(src).not.toMatch(/delta === 0 \? '='/);
    expect(src).toContain("costDelta === 0 ? '\u2014'");
    expect(src).toContain("durationDelta === 0 ? '\u2014'");
    expect(src).toContain("title={costDelta === 0 ? 'No change' : undefined}");
    expect(src).toContain("title={durationDelta === 0 ? 'No change' : undefined}");
    expect(src).toContain('data-testid="scoreboard-delta-cost"');
    expect(src).toContain('data-testid="scoreboard-delta-duration"');
  });

  it('formatDelta returns an em dash (not "=") when there is no difference', () => {
    expect(src).not.toMatch(/if \(diff === 0\) return '=';/);
    expect(src).toContain("if (diff === 0) return '\u2014';");
  });

  it('coverage cell shows shared count from overlap prop', () => {
    expect(src).toContain('overlap.sharedTestCases');
    expect(src).toContain('fully comparable');
  });

  it('run row click expands a detail drawer', () => {
    expect(src).toContain('RunDetailDrawer');
    expect(src).toContain('expandedRow');
    expect(src).toContain('setExpandedRow');
  });

  it('condensed state renders when isCondensed is true', () => {
    expect(src).toContain('CondensedBand');
    expect(src).toContain('isCondensed');
    expect(src).toContain('scoreboard-condensed');
  });

  it('uses IntersectionObserver for condensed transition', () => {
    expect(src).toContain('IntersectionObserver');
    expect(src).toContain('sentinelRef');
  });

  it('embeds MetricComparisonPanel inside an expandable "All metrics" section', () => {
    expect(src).toContain('<MetricComparisonPanel');
    expect(src).toContain('metricsExpanded');
    expect(src).toContain('scoreboard-all-metrics-toggle');
  });

  it('has the sticky positioning and correct z-index', () => {
    expect(src).toContain('sticky top-0 z-40');
  });

  it('uses bg-card border styling consistent with shadcn theme', () => {
    expect(src).toContain('bg-card border border-border rounded-lg');
  });

  it('"Open run" deep-links to the benchmark run page for benchmark runs, eval-run route for ad-hoc', () => {
    // Regression: the drawer used to always link /evaluations/runs/:runId,
    // which 404s (resolves only the SDK eval-run store) for benchmark run
    // ids. runBenchmarkIdById (per-run, since unscoped comparisons mix
    // benchmarks and ad-hoc eval-runs) now picks the right route.
    expect(src).toContain('runBenchmarkIdById');
    expect(src).toContain('/evaluations/benchmarks/${benchmarkId}/runs/${run.runId}');
    expect(src).toContain('/evaluations/runs/${run.runId}');
    expect(src).toContain('data-testid={`open-run-${run.runId}`}');
  });
});

describe('VerdictStrip and ModeToggle are removed', () => {
  it('VerdictStrip.tsx no longer exists', () => {
    const exists = fs.existsSync(path.resolve(__dirname, '../../../../components/comparison/VerdictStrip.tsx'));
    expect(exists).toBe(false);
  });

  it('ModeToggle.tsx no longer exists', () => {
    const exists = fs.existsSync(path.resolve(__dirname, '../../../../components/comparison/ModeToggle.tsx'));
    expect(exists).toBe(false);
  });

  it('ComparisonPage does not import VerdictStrip', () => {
    const page = read('components/comparison/ComparisonPage.tsx');
    expect(page).not.toContain("from './VerdictStrip'");
    expect(page).not.toContain('<VerdictStrip');
  });

  it('ComparisonPage does not use mode-forking logic', () => {
    const page = read('components/comparison/ComparisonPage.tsx');
    expect(page).not.toContain('modeOverride');
    expect(page).not.toContain("mode === 'compare'");
    expect(page).not.toContain("mode === 'iterate'");
  });

  it('barrel index exports ComparisonScoreboard instead of VerdictStrip/ModeToggle', () => {
    const idx = read('components/comparison/index.ts');
    expect(idx).toContain("export { ComparisonScoreboard }");
    expect(idx).not.toContain("VerdictStrip");
    expect(idx).not.toContain("ModeToggle");
  });
});

describe('ComparisonScoreboard "Open run" deep link (rendered)', () => {
  // Real render (not source-analysis): asserts the actual anchor href the
  // browser would navigate to, for both a benchmark run and an ad-hoc
  // eval-run in the same comparison pool. Regression coverage for the fix
  // where every run linked to /evaluations/runs/:runId and 404d for
  // benchmark run ids.
  const { ComparisonScoreboard } = require('@/components/comparison/ComparisonScoreboard');

  const overlap = {
    runCount: 2,
    totalTestCases: 5,
    sharedTestCases: 5,
    partialTestCases: 0,
    perRun: [],
    fullyOverlapping: true,
  };

  const makeRun = (runId: string) => ({
    runId,
    runName: runId,
    createdAt: new Date().toISOString(),
    modelId: 'claude-sonnet',
    agentKey: 'mock',
    totalTestCases: 5,
    passedCount: 5,
    failedCount: 0,
    avgAccuracy: 1,
    passRatePercent: 100,
  });

  const makeSelectedRun = (id: string) => ({
    id,
    name: id,
    createdAt: new Date().toISOString(),
    agentKey: 'mock',
    modelId: 'claude-sonnet',
    results: {},
  });

  it('deep-links a benchmark run to /evaluations/benchmarks/:benchmarkId/runs/:runId', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    fireEvent.click(screen.getByTestId('scoreboard-row-A'));
    const linkA = screen.getByTestId('open-run-run-a');
    expect(linkA.getAttribute('href')).toBe('/evaluations/benchmarks/bench-123/runs/run-a');
  });

  it('falls back to /evaluations/runs/:runId for an ad-hoc run with no benchmarkId', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    fireEvent.click(screen.getByTestId('scoreboard-row-B'));
    const linkB = screen.getByTestId('open-run-run-b');
    expect(linkB.getAttribute('href')).toBe('/evaluations/runs/run-b');
  });

  it('falls back to /evaluations/runs/:runId when runBenchmarkIdById is not provided at all', () => {
    const runA = makeRun('run-a');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA],
        selectedRuns: [makeSelectedRun('run-a')],
        overlap: { ...overlap, runCount: 1 },
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    fireEvent.click(screen.getByTestId('scoreboard-row-A'));
    const linkA = screen.getByTestId('open-run-run-a');
    expect(linkA.getAttribute('href')).toBe('/evaluations/runs/run-a');
  });
});
