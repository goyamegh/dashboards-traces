/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guards for Scope A UX paper-cut fixes.
 *
 * Each fix migrated a component away from hardcoded colors that broke in
 * one or both themes. These tests read the source files and assert the
 * specific bad patterns are not re-introduced.
 *
 * Why source-level rather than render-level: the breakage is in the class
 * strings themselves (Tailwind colors that ignore the .dark toggle, or
 * Recharts props with literal hex). Rendered DOM doesn't surface them
 * faithfully under JSDOM, but the source string does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('Scope A theming regressions', () => {
  describe('Fix #1 — RawEventsPanel uses theme tokens', () => {
    const src = read('components/RawEventsPanel.tsx');

    it('does not use hardcoded gray backgrounds', () => {
      expect(src).not.toMatch(/className="[^"]*\bbg-gray-(50|100|200)\b[^"]*"/);
    });

    it('does not use hardcoded gray text', () => {
      expect(src).not.toMatch(/\btext-gray-(500|600|700|800|900)\b/);
    });
  });

  describe('Fix #2 — Latency histogram bars are visible in dark mode', () => {
    it('LatencyHistogram bar palette includes dark variants', () => {
      const src = read('components/traces/LatencyHistogram.tsx');
      expect(src).toMatch(/dark:bg-/);
      // Old palette used bare bg-emerald-500 etc. without a dark: variant.
      // We accept any dark: counterpart, so just assert at least one exists
      // alongside each emerald/amber/red bar declaration.
      expect(src.match(/dark:bg-\w+-\d+\/\d+/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('MetricsOverview latency color helper has dark variants', () => {
      const src = read('components/traces/MetricsOverview.tsx');
      expect(src).toMatch(/dark:bg-green/);
      expect(src).toMatch(/dark:bg-red/);
    });
  });

  describe('Fix #3 — MetricsTimeSeriesChart axes are token-driven', () => {
    const src = read('components/comparison/MetricsTimeSeriesChart.tsx');

    it('axes/grid use CSS variables not hex literals', () => {
      // Recharts axes/grid must use hsl(var(--*)) so they react to theme.
      expect(src).toMatch(/CartesianGrid[^/]*stroke="hsl\(var\(--border\)\)"/s);
      expect(src).toMatch(/hsl\(var\(--muted-foreground\)\)/);
    });

    it('does not stroke axes with literal hex colors', () => {
      // Old code used #cbd5e1 / #64748b etc. for tick fill / stroke.
      expect(src).not.toMatch(/stroke="#[0-9a-fA-F]{3,8}"/);
      expect(src).not.toMatch(/fill: '#[0-9a-fA-F]{3,8}'/);
    });
  });

  describe('Fix #4 — React Flow surfaces use theme tokens', () => {
    const flowFiles = [
      'components/traces/TraceFlowView.tsx',
      'components/traces/AgentMapView.tsx',
      'components/comparison/sections/TraceFlowComparison.tsx',
    ];

    it.each(flowFiles)('%s uses CSS-var Background color', (rel) => {
      const src = read(rel);
      // Background dots/lines should reference --border, never a slate hex.
      expect(src).toMatch(/<Background[^>]*color="hsl\(var\(--border\)\)"/s);
      expect(src).not.toMatch(/color="#334155"/);
    });

    it.each(flowFiles)('%s MiniMap uses card/border tokens', (rel) => {
      const src = read(rel);
      expect(src).toMatch(/maskColor="hsl\(var\(--background\) \/ 0\.8\)"/);
      expect(src).not.toMatch(/!bg-slate-900\/50/);
      expect(src).not.toMatch(/!border-slate-700/);
    });

    it('SpanNode handles use muted-foreground/border tokens', () => {
      const src = read('components/traces/flow/SpanNode.tsx');
      expect(src).not.toMatch(/!bg-slate-400/);
      expect(src).not.toMatch(/!border-slate-600/);
      expect(src).toMatch(/!bg-muted-foreground\/60/);
      expect(src).toMatch(/!border-border/);
    });
  });

  describe('Fix #5 — Tooltip uses popover tokens, not hardcoded grays', () => {
    it('TooltipContent default classes use bg-popover + text-popover-foreground', () => {
      const src = read('components/ui/tooltip.tsx');
      expect(src).toMatch(/bg-popover/);
      expect(src).toMatch(/text-popover-foreground/);
      expect(src).not.toMatch(/bg-gray-900 dark:bg-gray-800/);
      expect(src).not.toMatch(/fill-gray-900/);
    });

    it('AgentTracesPage time-distribution tooltip drops hardcoded grays', () => {
      const src = read('components/traces/AgentTracesPage.tsx');
      // The Time Distribution TooltipContent should not re-introduce the
      // hardcoded gray-900/text-white override that fought the theme.
      expect(src).not.toMatch(
        /<TooltipContent[^>]*className="[^"]*bg-gray-900 dark:bg-gray-800[^"]*"/s
      );
      expect(src).not.toMatch(
        /<TooltipContent[^>]*className="[^"]*\[&>svg\]:fill-gray-900[^"]*"/s
      );
    });

    it('TraceFlyoutContent tooltip drops hardcoded grays', () => {
      const src = read('components/traces/TraceFlyoutContent.tsx');
      expect(src).not.toMatch(
        /<TooltipContent[^>]*className="[^"]*bg-gray-900 dark:bg-gray-800[^"]*"/s
      );
      expect(src).not.toMatch(
        /<TooltipContent[^>]*className="[^"]*\[&>svg\]:fill-gray-900[^"]*"/s
      );
    });
  });
});
