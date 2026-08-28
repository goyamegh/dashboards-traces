/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for AgentTrendsLegendDrawer — the "Agents (N)" dropdown that
 * replaces the always-visible chips row in the Agent Trends band.
 *
 * Covers:
 *  - Trigger renders the agent count and starts closed
 *  - Opening the drawer lists one row per agent with the same summary
 *    fields the old chips row showed (latest accuracy, WoW delta,
 *    cost/run, tokens/run) — i.e. the drawer's math is
 *    `computeAgentChipSummaries` output rendered as-is, not reimplemented.
 *  - Unchecking an agent's checkbox calls onToggleAgent with its key
 *    (the band wires this to hiding that agent's chart series).
 *  - Renders nothing when there are no agents in scope.
 */

import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentTrendsLegendDrawer } from '@/components/dashboard/AgentTrendsLegendDrawer';
import { computeAgentChipSummaries, buildAgentRunPoints, buildAgentColorMap } from '@/lib/agentTrends';
import type { Benchmark, BenchmarkRun } from '@/types';

function makeRun(overrides: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'Run 1',
    createdAt: '2024-06-01T00:00:00.000Z',
    agentKey: 'agent-a',
    modelId: 'claude-sonnet',
    results: {},
    ...overrides,
  };
}

function makeBenchmark(id: string, name: string, runs: BenchmarkRun[]): Benchmark {
  return {
    id,
    name,
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2024-01-01T00:00:00.000Z', testCaseIds: [] }],
    testCaseIds: [],
    runs,
  };
}

describe('AgentTrendsLegendDrawer', () => {
  afterEach(() => cleanup());

  function buildChips() {
    const bm = makeBenchmark('bm-1', 'B', [
      makeRun({ id: 'r1', agentKey: 'agent-alpha', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
      makeRun({ id: 'r2', agentKey: 'agent-alpha', createdAt: '2024-06-08T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
      makeRun({ id: 'r3', agentKey: 'agent-beta', createdAt: '2024-06-02T00:00:00Z', stats: { passed: 3, failed: 7, pending: 0, total: 10 } }),
    ]);
    const points = buildAgentRunPoints([bm], [], new Map());
    const chips = computeAgentChipSummaries(points, new Date('2024-06-09T00:00:00Z').getTime());
    const colorMap = buildAgentColorMap(chips.map(c => c.agentKey));
    return { chips, colorMap };
  }

  it('renders nothing when there are no agents in scope', () => {
    const { container } = render(
      React.createElement(AgentTrendsLegendDrawer, {
        chips: [],
        colorMap: new Map(),
        hiddenAgentKeys: new Set(),
        onToggleAgent: jest.fn(),
      })
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the agent count on the closed trigger and opens the drawer on click', () => {
    const { chips, colorMap } = buildChips();
    render(
      React.createElement(AgentTrendsLegendDrawer, {
        chips, colorMap, hiddenAgentKeys: new Set(), onToggleAgent: jest.fn(),
      })
    );

    const trigger = screen.getByTestId('agent-trends-agents-toggle');
    expect(trigger.textContent).toContain('2');
    expect(screen.queryByTestId('agent-trends-agents-menu')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId('agent-trends-agents-menu')).toBeTruthy();
  });

  it('lists every agent with the same summary fields the chips row used to show', () => {
    const { chips, colorMap } = buildChips();
    render(
      React.createElement(AgentTrendsLegendDrawer, {
        chips, colorMap, hiddenAgentKeys: new Set(), onToggleAgent: jest.fn(),
      })
    );
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));

    const alphaRow = screen.getByTestId('agent-trends-agents-menu-row-agent-alpha');
    expect(alphaRow.textContent).toContain('80.0%'); // latest accuracy
    expect(alphaRow.textContent).toContain('+20pp'); // wow delta: 60% -> 80%
    expect(alphaRow.textContent).toContain('—/run'); // no trace cost data seeded -> honest dash
    expect(alphaRow.textContent).toContain('— tok');

    const betaRow = screen.getByTestId('agent-trends-agents-menu-row-agent-beta');
    expect(betaRow.textContent).toContain('30.0%');
  });

  it('unchecking an agent calls onToggleAgent with its key', () => {
    const { chips, colorMap } = buildChips();
    const onToggleAgent = jest.fn();
    render(
      React.createElement(AgentTrendsLegendDrawer, {
        chips, colorMap, hiddenAgentKeys: new Set(), onToggleAgent,
      })
    );
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));

    const checkbox = screen.getByTestId('agent-trends-agent-visibility-agent-alpha');
    expect(checkbox.getAttribute('data-state')).toBe('checked');
    fireEvent.click(checkbox);
    expect(onToggleAgent).toHaveBeenCalledWith('agent-alpha');
  });

  it("renders a hidden agent's checkbox as unchecked", () => {
    const { chips, colorMap } = buildChips();
    render(
      React.createElement(AgentTrendsLegendDrawer, {
        chips, colorMap, hiddenAgentKeys: new Set(['agent-beta']), onToggleAgent: jest.fn(),
      })
    );
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));

    expect(screen.getByTestId('agent-trends-agent-visibility-agent-alpha').getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('agent-trends-agent-visibility-agent-beta').getAttribute('data-state')).toBe('unchecked');
  });
});
