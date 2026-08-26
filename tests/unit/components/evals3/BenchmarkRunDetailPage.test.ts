/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for BenchmarkRunDetailPage's test-case loading strategy.
 *
 * Covers the eval-source lazy-fetch fix (same pattern as
 * RunInspectorPage.test.ts): the bulk `getByIds` load for the results table
 * is a SUMMARY fetch (no `sourceCode` -- every test case parsed from one
 * eval file shares the identical file text, so a full fetch here would
 * duplicate it once per row just to paint a list), and the flyout's full
 * `TestCase` (including `sourceCode`, needed by
 * `CollapsibleTestCaseDefinition`'s eval-source view) is fetched lazily via
 * `getById` only when a row's flyout opens.
 *
 * Written with React.createElement (not JSX) -- this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockNavigate = jest.fn();
let mockParams: Record<string, string | undefined> = { benchmarkId: 'bench-1', runId: 'run-1' };

jest.mock('react-router-dom', () => ({
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) =>
    React.createElement('a', { href: to }, children),
}));

const mockBenchmarkGetById = jest.fn();
const mockTestCasesGetByIds = jest.fn();
const mockTestCaseGetById = jest.fn();
const mockGetByBenchmarkRun = jest.fn();

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: { getById: (...a: unknown[]) => mockBenchmarkGetById(...a) },
  asyncTestCaseStorage: {
    getByIds: (...a: unknown[]) => mockTestCasesGetByIds(...a),
    getById: (...a: unknown[]) => mockTestCaseGetById(...a),
  },
  asyncRunStorage: { getByBenchmarkRun: (...a: unknown[]) => mockGetByBenchmarkRun(...a) },
}));

// Stub the flyout so we can assert the `testCase` prop it received without
// rendering the full trajectory/judge tree.
jest.mock('@/components/evals3/RunDetailsFlyout', () => ({
  RunDetailsFlyout: ({ testCase }: { testCase: { name?: string; sourceCode?: string } | null }) =>
    React.createElement('div', { 'data-testid': 'flyout' },
      React.createElement('span', { 'data-testid': 'flyout-name' }, testCase?.name || ''),
      React.createElement('span', { 'data-testid': 'flyout-has-source' }, testCase?.sourceCode ? 'yes' : 'no'),
    ),
}));

import { BenchmarkRunDetailPage } from '@/components/evals3/BenchmarkRunDetailPage';

function makeBenchmark() {
  return {
    id: 'bench-1',
    name: 'Bench',
    runs: [{ id: 'run-1', results: { 'tc-0': { reportId: 'rep-0' }, 'tc-1': { reportId: 'rep-1' } } }],
  };
}

function makeSummaryTestCases() {
  // Summary shape: no sourceCode/context/expectedOutcomes.
  return [
    { id: 'tc-0', name: 'Case 0', labels: [] },
    { id: 'tc-1', name: 'Case 1', labels: [] },
  ];
}

function makeReports() {
  return [
    { id: 'rep-0', status: 'completed', passFailStatus: 'passed', metrics: {} },
    { id: 'rep-1', status: 'completed', passFailStatus: 'failed', metrics: {} },
  ];
}

const renderPage = () => render(React.createElement(BenchmarkRunDetailPage));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
  mockBenchmarkGetById.mockResolvedValue(makeBenchmark());
  mockTestCasesGetByIds.mockResolvedValue(makeSummaryTestCases());
  mockGetByBenchmarkRun.mockResolvedValue(makeReports());
  mockTestCaseGetById.mockResolvedValue(null);
});

describe('BenchmarkRunDetailPage — eval-source lazy fetch', () => {
  it('bulk-loads test cases as a SUMMARY (no sourceCode) for the results table', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('Case 0')).toBeTruthy());
    expect(mockTestCasesGetByIds).toHaveBeenCalledWith(
      expect.arrayContaining(['tc-0', 'tc-1']),
      { summary: true }
    );
  });

  it('fetches the FULL test case (with sourceCode) only when a row with a report is clicked', async () => {
    mockTestCaseGetById.mockResolvedValue({
      id: 'tc-1',
      name: 'Case 1',
      sourceFile: 'evals/foo.eval.ts',
      sourceCode: "test('a', () => {});",
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Case 1')).toBeTruthy());

    fireEvent.click(screen.getByText('Case 1'));

    await waitFor(() => expect(mockTestCaseGetById).toHaveBeenCalledWith('tc-1'));
    await waitFor(() => expect(screen.getByTestId('flyout-has-source').textContent).toBe('yes'));
    expect(screen.getByTestId('flyout-name').textContent).toBe('Case 1');
  });

  it('does not fetch a full test case when no row has been clicked', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Case 0')).toBeTruthy());

    expect(mockTestCaseGetById).not.toHaveBeenCalled();
    expect(screen.queryByTestId('flyout')).toBeNull();
  });
});
