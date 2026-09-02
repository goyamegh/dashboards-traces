/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RunInsightsPane — the right-side pane shown on the
 * redesigned legacy run-report page (RunDetailsPage.tsx) when no test case
 * is selected. Covers:
 *  - verdict overview + category bars render from the passed-in rows
 *  - the capped-reasoning-fetch path (getReportReasoningsByIds), including
 *    the "Based on N of M" note
 *  - clicking a failure theme calls onFilterCases with that theme's ids
 *  - clicking a slowest/costliest case calls onSelectCase
 */

import * as React from 'react';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { RunInsightsPane } from '@/components/RunInsightsPane';
import type { ExperimentRun, EvaluationReport, TestCase } from '@/types';

const getReportReasoningsByIds = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncRunStorage: {
    getReportReasoningsByIds: (...args: unknown[]) => getReportReasoningsByIds(...args),
  },
}));

const fetchBatchMetrics = jest.fn();
jest.mock('@/services/metrics', () => ({
  fetchBatchMetrics: (...args: unknown[]) => fetchBatchMetrics(...args),
  formatCost: (usd: number) => `$${usd.toFixed(2)}`,
  formatDuration: (ms: number) => `${ms}ms`,
  formatTokens: (n: number) => `${n}tok`,
}));

function makeTestCase(id: string, category: string): TestCase {
  return { id, name: id, category, difficulty: 'Easy' } as unknown as TestCase;
}

function makeRun(results: ExperimentRun['results']): ExperimentRun {
  return {
    id: 'run-1',
    name: 'Run 1',
    results,
  } as unknown as ExperimentRun;
}

const baseStats = { passed: 1, failed: 2, errored: 0, pending: 0, running: 0, total: 3 };

describe('RunInsightsPane', () => {
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it('renders verdict overview and category bars from the case rows', async () => {
    getReportReasoningsByIds.mockResolvedValue({});
    fetchBatchMetrics.mockResolvedValue({ metrics: [], aggregate: null });

    const testCases = [makeTestCase('tc-1', 'RAG'), makeTestCase('tc-2', 'RAG'), makeTestCase('tc-3', 'Tools')];
    const run = makeRun({
      'tc-1': { reportId: 'r1', status: 'completed' },
      'tc-2': { reportId: 'r2', status: 'completed' },
      'tc-3': { reportId: 'r3', status: 'completed' },
    });
    const reportsMap: Record<string, EvaluationReport | null> = {
      r1: { passFailStatus: 'passed' } as EvaluationReport,
      r2: { passFailStatus: 'failed' } as EvaluationReport,
      r3: { passFailStatus: 'failed' } as EvaluationReport,
    };

    render(
      React.createElement(RunInsightsPane, {
        experimentRun: run,
        testCases,
        reportsMap,
        stats: baseStats,
        onSelectCase: jest.fn(),
        onFilterCases: jest.fn(),
      })
    );

    expect(screen.getByTestId('run-insights-pane')).toBeTruthy();
    expect(screen.getByTestId('run-insights-verdicts').textContent).toContain('/ 3');
    const bars = screen.getAllByTestId('run-insights-category-bar');
    expect(bars).toHaveLength(2);
    // RAG (2 total) sorts before Tools (1 total).
    expect(bars[0].textContent).toContain('RAG');
    expect(bars[1].textContent).toContain('Tools');
  });

  it('fetches reasoning for failing cases only, clusters them, and filters the list on theme click', async () => {
    fetchBatchMetrics.mockResolvedValue({ metrics: [], aggregate: null });
    getReportReasoningsByIds.mockResolvedValue({
      r1: { llmJudgeReasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.' },
      r2: { llmJudgeReasoning: 'The agent failed to retrieve any information from the corpus due to tool connectivity issues entirely.' },
    });

    const testCases = [makeTestCase('tc-1', 'RAG'), makeTestCase('tc-2', 'RAG'), makeTestCase('tc-3', 'RAG')];
    const run = makeRun({
      'tc-1': { reportId: 'r1', status: 'completed' },
      'tc-2': { reportId: 'r2', status: 'completed' },
      'tc-3': { reportId: 'r3', status: 'completed' },
    });
    const reportsMap: Record<string, EvaluationReport | null> = {
      r1: { passFailStatus: 'failed' } as EvaluationReport,
      r2: { passFailStatus: 'failed' } as EvaluationReport,
      r3: { passFailStatus: 'passed' } as EvaluationReport,
    };
    const onFilterCases = jest.fn();

    render(
      React.createElement(RunInsightsPane, {
        experimentRun: run,
        testCases,
        reportsMap,
        stats: { passed: 1, failed: 2, errored: 0, pending: 0, running: 0, total: 3 },
        onSelectCase: jest.fn(),
        onFilterCases,
      })
    );

    // Only the 2 failing reportIds are requested (not r3, the passing one).
    await waitFor(() => expect(getReportReasoningsByIds).toHaveBeenCalledWith(['r1', 'r2']));

    const themeButton = await screen.findByTestId('run-insights-theme');
    expect(themeButton.textContent).toContain('2 cases');

    fireEvent.click(themeButton);
    expect(onFilterCases).toHaveBeenCalledWith(expect.arrayContaining(['tc-1', 'tc-2']));
  });

  it('shows a "Based on N of M failing cases" note when there are more than 100 failing cases', async () => {
    fetchBatchMetrics.mockResolvedValue({ metrics: [], aggregate: null });

    const N = 110;
    const results: ExperimentRun['results'] = {};
    const reportsMap: Record<string, EvaluationReport | null> = {};
    const testCases: TestCase[] = [];
    const reasoningResponse: Record<string, { llmJudgeReasoning: string }> = {};
    for (let i = 0; i < N; i++) {
      const tcId = `tc-${i}`;
      const reportId = `r-${i}`;
      results[tcId] = { reportId, status: 'completed' };
      reportsMap[reportId] = { passFailStatus: 'failed' } as EvaluationReport;
      testCases.push(makeTestCase(tcId, 'RAG'));
      // Only the first 100 (the cap) are ever requested, but stub every id
      // defensively so a bug that over-fetches doesn't get masked by an
      // empty response.
      reasoningResponse[reportId] = { llmJudgeReasoning: `Unique unrelated failure text number ${i} with no shared phrasing at all.` };
    }
    getReportReasoningsByIds.mockImplementation(async (ids: string[]) => {
      const out: Record<string, { llmJudgeReasoning: string }> = {};
      for (const id of ids) out[id] = reasoningResponse[id];
      return out;
    });

    render(
      React.createElement(RunInsightsPane, {
        experimentRun: makeRun(results),
        testCases,
        reportsMap,
        stats: { passed: 0, failed: N, errored: 0, pending: 0, running: 0, total: N },
        onSelectCase: jest.fn(),
        onFilterCases: jest.fn(),
      })
    );

    await waitFor(() => expect(getReportReasoningsByIds).toHaveBeenCalled());
    const requestedIds = getReportReasoningsByIds.mock.calls[0][0] as string[];
    expect(requestedIds).toHaveLength(100);

    const note = await screen.findByTestId('run-insights-capped-note');
    expect(note.textContent).toContain(`Based on 100 of ${N} failing cases`);
  });

  it('renders slowest/costliest and routes clicks through onSelectCase', async () => {
    getReportReasoningsByIds.mockResolvedValue({});
    fetchBatchMetrics.mockResolvedValue({
      metrics: [
        { runId: 'run-a', costUsd: 0.5, durationMs: 100, inputTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'success' },
        { runId: 'run-b', costUsd: 2.5, durationMs: 200, inputTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'success' },
      ],
      aggregate: { totalInputTokens: 10, totalOutputTokens: 20, avgDurationMs: 150 },
    });

    const testCases = [makeTestCase('tc-1', 'RAG'), makeTestCase('tc-2', 'RAG')];
    const run = makeRun({
      'tc-1': { reportId: 'r1', status: 'completed', performanceMetrics: { durationMs: 5000, agentDurationMs: 4000 } },
      'tc-2': { reportId: 'r2', status: 'completed', performanceMetrics: { durationMs: 1000, agentDurationMs: 800 } },
    });
    const reportsMap: Record<string, EvaluationReport | null> = {
      r1: { passFailStatus: 'passed', runId: 'run-a' } as EvaluationReport,
      r2: { passFailStatus: 'passed', runId: 'run-b' } as EvaluationReport,
    };
    const onSelectCase = jest.fn();

    render(
      React.createElement(RunInsightsPane, {
        experimentRun: run,
        testCases,
        reportsMap,
        stats: { passed: 2, failed: 0, errored: 0, pending: 0, running: 0, total: 2 },
        onSelectCase,
        onFilterCases: jest.fn(),
      })
    );

    // tc-1 has the longer durationMs -> slowest.
    const slowest = await screen.findByTestId('run-insights-slowest');
    expect(slowest.textContent).toContain('tc-1');

    // tc-2's run has the higher costUsd -> costliest.
    const costliest = await screen.findByTestId('run-insights-costliest');
    await waitFor(() => expect(costliest.textContent).toContain('tc-2'));

    fireEvent.click(within(slowest).getByRole('button', { name: /tc-1/ }));
    expect(onSelectCase).toHaveBeenCalledWith('tc-1');
  });

  it('does not render the "Why runs failed" section when there are no failing cases', () => {
    getReportReasoningsByIds.mockResolvedValue({});
    fetchBatchMetrics.mockResolvedValue({ metrics: [], aggregate: null });

    render(
      React.createElement(RunInsightsPane, {
        experimentRun: makeRun({ 'tc-1': { reportId: 'r1', status: 'completed' } }),
        testCases: [makeTestCase('tc-1', 'RAG')],
        reportsMap: { r1: { passFailStatus: 'passed' } as EvaluationReport },
        stats: { passed: 1, failed: 0, errored: 0, pending: 0, running: 0, total: 1 },
        onSelectCase: jest.fn(),
        onFilterCases: jest.fn(),
      })
    );

    expect(screen.queryByText('Why runs failed')).toBeNull();
    expect(getReportReasoningsByIds).not.toHaveBeenCalled();
  });
});
