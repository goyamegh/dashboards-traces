/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for AgentTrendsAgentListDrawer — the secondary "History (N
 * agents)" drawer (v3 replacement for the old checkbox-based
 * AgentTrendsLegendDrawer, which hid/showed series on the retired
 * all-agents overlay chart). Covers: trigger renders the agent count,
 * opening lists one row per agent, the name filter narrows the list, and
 * clicking a row calls onSelectAgent with that agent's key.
 */

import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentTrendsAgentListDrawer } from '@/components/dashboard/AgentTrendsAgentListDrawer';
import { buildAgentRunPoints, buildAgentTrendRows } from '@/lib/agentTrends';
import type { Benchmark, BenchmarkRun } from '@/types';

afterEach(cleanup);

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

function makeBenchmark(runs: BenchmarkRun[]): Benchmark {
  return {
    id: 'bm-1',
    name: 'Benchmark One',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2024-01-01T00:00:00.000Z', testCaseIds: [] }],
    testCaseIds: [],
    runs,
  };
}

function rows() {
  const points = buildAgentRunPoints([makeBenchmark([
    makeRun({ id: 'a1', agentKey: 'agent-alpha', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
    makeRun({ id: 'b1', agentKey: 'agent-beta', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 5, failed: 5, pending: 0, total: 10 } }),
  ])], [], new Map());
  return buildAgentTrendRows(points, 'accuracy');
}

describe('AgentTrendsAgentListDrawer', () => {
  it('renders nothing when there are no agents in scope', () => {
    const { container } = render(React.createElement(AgentTrendsAgentListDrawer, {
      rows: [], metric: 'accuracy', onSelectAgent: jest.fn(),
    }));
    expect(container.firstChild).toBeNull();
  });

  it('trigger shows the agent count and starts closed', () => {
    render(React.createElement(AgentTrendsAgentListDrawer, { rows: rows(), metric: 'accuracy', onSelectAgent: jest.fn() }));
    expect(screen.getByTestId('agent-trends-agents-toggle').textContent).toContain('2');
    expect(screen.queryByTestId('agent-trends-agents-menu')).toBeNull();
  });

  it('opening the drawer lists one row per agent', () => {
    render(React.createElement(AgentTrendsAgentListDrawer, { rows: rows(), metric: 'accuracy', onSelectAgent: jest.fn() }));
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));
    expect(screen.getByTestId('agent-trend-row-agent-alpha')).toBeTruthy();
    expect(screen.getByTestId('agent-trend-row-agent-beta')).toBeTruthy();
  });

  it('the name filter narrows the list to matching agents', () => {
    render(React.createElement(AgentTrendsAgentListDrawer, { rows: rows(), metric: 'accuracy', onSelectAgent: jest.fn() }));
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));
    fireEvent.change(screen.getByTestId('agent-trends-agents-filter'), { target: { value: 'alpha' } });
    expect(screen.getByTestId('agent-trend-row-agent-alpha')).toBeTruthy();
    expect(screen.queryByTestId('agent-trend-row-agent-beta')).toBeNull();
  });

  it('clicking a row calls onSelectAgent with that agent key', () => {
    const onSelectAgent = jest.fn();
    render(React.createElement(AgentTrendsAgentListDrawer, { rows: rows(), metric: 'accuracy', onSelectAgent }));
    fireEvent.click(screen.getByTestId('agent-trends-agents-toggle'));
    fireEvent.click(screen.getByTestId('agent-trend-row-agent-alpha'));
    expect(onSelectAgent).toHaveBeenCalledWith('agent-alpha');
  });
});
