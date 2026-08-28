/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for EvalRunsPage (codecov/patch #430 follow-up).
 *
 * PR #430 removed the redundant left-side status icon column (and its
 * header cell), which shifted every `colSpan` in the table (empty-state row,
 * grouped-view group-header row, infinite-scroll sentinel row) down by one,
 * and switched `computeRunStats` to the shared `lib/runStats` helper. These
 * tests mount the real page and exercise:
 *  - the empty-state row's `colSpan` in BOTH view modes (flat=8, grouped=7)
 *  - the Flat/Grouped view toggle actually re-rendering the table (Benchmark
 *    column only shown in flat mode; group header rows only in grouped mode)
 *  - stats computed via lib/runStats.computeRunStats flow into the rendered
 *    pass/fail/total counts (no left-side icon column left behind)
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Benchmark, BenchmarkRun } from '@/types';

// ── react-router-dom ─────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetAllBenchmarks = jest.fn();
const mockGetReportSummariesByIds = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: { getAll: (...a: unknown[]) => mockGetAllBenchmarks(...a) },
  asyncTestCaseStorage: {},
  asyncRunStorage: { getReportSummariesByIds: (...a: unknown[]) => mockGetReportSummariesByIds(...a) },
}));

const mockListEvaluationRuns = jest.fn();
jest.mock('@/services/client', () => ({
  listEvaluationRuns: (...a: unknown[]) => mockListEvaluationRuns(...a),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [{ key: 'agent-a', name: 'Agent A', enabled: true }], models: {} },
}));

jest.mock('@/lib/utils', () => ({
  formatRelativeTime: jest.fn(() => 'just now'),
  getModelName: jest.fn((id: string) => id),
  cn: jest.fn((...args: unknown[]) => args.filter(Boolean).join(' ')),
}));

jest.mock('@/components/evals3/Breadcrumbs', () => ({
  Breadcrumbs: ({ actions }: { actions?: React.ReactNode }) =>
    React.createElement('nav', { 'data-testid': 'breadcrumbs' }, actions),
}));

import { EvalRunsPage } from '@/components/evals3/EvalRunsPage';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'Run One',
    createdAt: new Date().toISOString(),
    agentKey: 'agent-a',
    modelId: 'claude-3',
    results: {
      'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' } as any,
      'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'failed' } as any,
    },
    ...overrides,
  } as BenchmarkRun;
}

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: 'bench-1',
    name: 'Benchmark One',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentVersion: 1,
    versions: [],
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [makeRun()],
    ...overrides,
  } as Benchmark;
}

async function renderPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(React.createElement(EvalRunsPage));
  });
  await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  mockGetReportSummariesByIds.mockResolvedValue({});
  mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [] });
});

describe('EvalRunsPage — empty state colSpan (issue: left status-icon column removal)', () => {
  beforeEach(() => {
    mockGetAllBenchmarks.mockResolvedValue([]);
  });

  it('uses colSpan=8 for the empty-state row in flat view (was 9 before the icon column was removed)', async () => {
    const { container } = await renderPage();

    await waitFor(() => {
      const cell = container.querySelector('tbody td[colspan]') as HTMLTableCellElement | null;
      expect(cell).toBeTruthy();
      expect(cell!.colSpan).toBe(8);
    });
  });

  it('uses colSpan=7 for the empty-state row in grouped view (was 8 before the icon column was removed)', async () => {
    const { container } = await renderPage();

    fireEvent.click(screen.getByTestId('viewmode-grouped'));

    await waitFor(() => {
      const cell = container.querySelector('tbody td[colspan]') as HTMLTableCellElement | null;
      expect(cell).toBeTruthy();
      expect(cell!.colSpan).toBe(7);
    });
  });
});

describe('EvalRunsPage — Flat/Grouped view toggle', () => {
  beforeEach(() => {
    mockGetAllBenchmarks.mockResolvedValue([
      makeBenchmark({ id: 'bench-1', name: 'Benchmark One', runs: [makeRun({ id: 'run-1', name: 'Run One' })] }),
      makeBenchmark({ id: 'bench-2', name: 'Benchmark Two', runs: [makeRun({ id: 'run-2', name: 'Run Two', agentKey: 'agent-a' })] }),
    ]);
  });

  it('shows the per-row Benchmark column in flat view and hides it in grouped view', async () => {
    await renderPage();

    // Flat is the default view mode. Query the column header specifically
    // (role=columnheader) to disambiguate from the grouped-view "Benchmark"
    // kind-badge, which always renders the same literal text per group.
    expect(screen.getByRole('columnheader', { name: 'Benchmark' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Run One')).toBeTruthy());

    fireEvent.click(screen.getByTestId('viewmode-grouped'));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Benchmark' })).toBeNull());
    // Grouped view renders a header row per benchmark instead.
    await waitFor(() => expect(screen.getByText('Benchmark One')).toBeTruthy());
    expect(screen.getByText('Benchmark Two')).toBeTruthy();

    fireEvent.click(screen.getByTestId('viewmode-flat'));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Benchmark' })).toBeTruthy());
  });

  it('computes pass/fail counts via the shared lib/runStats helper (no stale run.stats trust, no left icon column)', async () => {
    await renderPage();

    // renderRunRow no longer emits a left-side status-icon <td>; the row's
    // first two cells are now [checkbox, run name] — regression guard for
    // the removed CheckCircle2/XCircle/Clock column.
    await waitFor(() => expect(screen.getByText('Run One')).toBeTruthy());
    const row = screen.getByText('Run One').closest('tr') as HTMLElement;
    const cells = row.querySelectorAll('td');
    // First cell is the selection checkbox button, second is the run name —
    // there is no icon-only third cell between them.
    expect(cells[0].querySelector('button')).toBeTruthy();
    expect(cells[1].textContent).toContain('Run One');

    // 1 passed / 1 failed / 0 errored / total 2, computed via bucketRunResults
    // (scoped to this row since every fixture run shares the same shape).
    expect(row.querySelector('.text-green-500')?.textContent).toBe('1');
    expect(row.querySelector('.text-red-500')?.textContent).toBe('1');
  });
});

describe('EvalRunsPage — top-level evaluation-runs merge (RunRow convergence)', () => {
  beforeEach(() => {
    mockGetAllBenchmarks.mockResolvedValue([]);
    mockListEvaluationRuns.mockResolvedValue({
      evaluationRuns: [
        {
          id: 'eval-run-1',
          docType: 'evaluation-run',
          name: 'Ad-hoc Eval Run',
          createdAt: new Date().toISOString(),
          status: 'completed',
          agentKey: 'agent-a',
          modelId: 'claude-3',
          sources: [],
          trigger: 'ui',
          testCaseSnapshots: [],
          results: {
            'tc-1': { reportId: 'report-9', status: 'completed', passFailStatus: 'passed' } as any,
          },
        },
      ],
    });
  });

  it('renders an ad-hoc (benchmark-free) evaluation-run row with stats from the shared computeRunStats helper', async () => {
    await renderPage();

    await waitFor(() => expect(screen.getByText('Ad-hoc Eval Run')).toBeTruthy());
    const row = screen.getByText('Ad-hoc Eval Run').closest('tr') as HTMLElement;
    // 1 passed / 0 failed / 0 errored / total 1 for the single passed result.
    expect(row.querySelector('.text-green-500')?.textContent).toBe('1');
    expect(row.querySelector('.text-red-500')?.textContent).toBe('0');
  });
});
