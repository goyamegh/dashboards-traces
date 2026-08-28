/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers just the app-wide per-agent color hook (`getAgentColor`), newly
 * relied upon by AgentBenchmarkDotPlot for "color coded for datapoints,
 * consistent palette with the rest of the app" (owner feedback). The rest
 * of lib/dashboardMetrics.ts is exercised indirectly by its consumers.
 */

import { AGENT_COLORS, getAgentColor } from '@/lib/dashboardMetrics';

describe('getAgentColor', () => {
  it('honors an explicit AGENT_COLORS override', () => {
    expect(getAgentColor('demo')).toBe(AGENT_COLORS['demo']);
  });

  it('is deterministic for an unmapped key (same key -> same color, every call)', () => {
    const first = getAgentColor('claude-code-agent');
    for (let i = 0; i < 5; i++) {
      expect(getAgentColor('claude-code-agent')).toBe(first);
    }
  });

  it('is independent of any other agent being resolved in between (a hash, not a sorted-index assignment)', () => {
    const before = getAgentColor('agent-x');
    getAgentColor('agent-a');
    getAgentColor('agent-z');
    getAgentColor('zzz-agent');
    expect(getAgentColor('agent-x')).toBe(before);
  });

  it('assigns different colors to at least some of a varied set of agent keys (not a single flat fallback)', () => {
    const keys = ['pi-agent', 'claude-code-agent', 'kiro-agent', 'observio-sample-agent', 'my-custom-agent'];
    const colors = new Set(keys.map(getAgentColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('always returns a non-empty hex-ish color string for an arbitrary key', () => {
    expect(getAgentColor('')).toMatch(/^#/);
    expect(getAgentColor('some-very-long-agent-key-with-many-characters-in-it')).toMatch(/^#/);
  });
});
