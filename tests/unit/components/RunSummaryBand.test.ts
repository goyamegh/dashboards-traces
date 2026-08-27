/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RunSummaryBand — the compact "at a glance" header
 * rendered on the redesigned legacy run-report page
 * (/benchmarks/:benchmarkId/runs/:runId, RunDetailsPage.tsx).
 *
 * Covers the data-mapping contract callers rely on:
 *  - agent/model/judge/evaluator labels render as passed in
 *  - verdict counts (passed/failed/errored/pending/running/total) render
 *  - optional fields (started, duration, cost) are omitted when absent
 */

import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { RunSummaryBand } from '@/components/RunSummaryBand';

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn().mockReturnValue('Jan 1, 2024'),
}));

jest.mock('@/services/metrics', () => ({
  formatDuration: jest.fn((ms: number) => `${ms}ms`),
  formatCost: jest.fn((usd: number) => `$${usd.toFixed(2)}`),
}));

const baseStats = { passed: 3, failed: 1, errored: 0, pending: 0, running: 0, total: 4 };

describe('RunSummaryBand', () => {
  afterEach(() => cleanup());

  it('renders run name, agent/model, judge/evaluator labels, and verdict counts', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'My Benchmark Run',
        agentName: 'Claude Code',
        modelName: 'Claude 4.5',
        judgeModelLabel: 'Claude 3.7 Sonnet',
        evaluatorLabel: 'RCA Default',
        stats: baseStats,
      })
    );

    expect(screen.getByTestId('run-title').textContent).toBe('My Benchmark Run');
    expect(screen.getByText(/Claude Code/)).toBeTruthy();
    expect(screen.getByText(/Claude 4\.5/)).toBeTruthy();
    expect(screen.getByTestId('run-summary-band-judge').textContent).toContain('Claude 3.7 Sonnet');
    expect(screen.getByTestId('run-summary-band-evaluator').textContent).toContain('RCA Default');

    const verdicts = screen.getByTestId('run-summary-band-verdicts');
    expect(verdicts.textContent).toContain('3'); // passed
    expect(verdicts.textContent).toContain('1'); // failed
    expect(verdicts.textContent).toContain('/ 4'); // total
  });

  it('shows an errored chip only when errored > 0', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        stats: baseStats,
      })
    );
    expect(screen.queryByTitle(/Evaluator could not run/)).toBeNull();

    cleanup();

    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        stats: { ...baseStats, errored: 2, total: 6 },
      })
    );
    expect(screen.getByTitle(/Evaluator could not run/).textContent).toContain('2');
  });

  it('shows pending/running chips only when their counts are > 0', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        stats: { passed: 1, failed: 0, errored: 0, pending: 2, running: 3, total: 6 },
      })
    );
    expect(screen.getByTitle('Pending').textContent).toContain('2');
    expect(screen.getByTitle('Running').textContent).toContain('3');
  });

  it('omits started/duration/cost when not provided', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        stats: baseStats,
      })
    );
    expect(screen.queryByTestId('run-summary-band-cost')).toBeNull();
    expect(screen.queryByText(/Run duration:/)).toBeNull();
    expect(screen.queryByText('Jan 1, 2024')).toBeNull();
  });

  it('renders started date, duration, concurrency, and cost when provided', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        startedAt: '2024-01-01T00:00:00Z',
        durationMs: 12345,
        concurrency: 4,
        costUsd: 1.2345,
        stats: baseStats,
      })
    );
    expect(screen.getByText('Jan 1, 2024')).toBeTruthy();
    expect(screen.getByText(/Run duration: 12345ms/)).toBeTruthy();
    expect(screen.getByText(/Concurrency: 4/)).toBeTruthy();
    expect(screen.getByTestId('run-summary-band-cost').textContent).toContain('$1.23');
  });

  it('renders the benchmark name and description when present', () => {
    render(
      React.createElement(RunSummaryBand, {
        runName: 'Run',
        description: 'Nightly regression sweep',
        benchmarkName: 'RCA Benchmark',
        agentName: 'A',
        modelName: 'M',
        judgeModelLabel: '\u2014',
        evaluatorLabel: '\u2014',
        stats: baseStats,
      })
    );
    expect(screen.getByText(/RCA Benchmark/)).toBeTruthy();
    expect(screen.getByText('Nightly regression sweep')).toBeTruthy();
  });
});
