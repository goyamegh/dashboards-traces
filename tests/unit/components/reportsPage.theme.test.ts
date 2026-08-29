/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for ReportsPage's difficulty badge under both themes (Scope B
 * theming fix, codecov/patch #219 follow-up: "add tests for both themes").
 *
 * The fix replaced the sidebar difficulty badge's dark-only classes
 * (`bg-*-900/30 text-*-400 border-*-800`, illegible against a light
 * background) with a light+dark token pairing for all three branches of the
 * Easy/Medium/Hard ternary. These tests render the real component (storage/
 * metrics services mocked, no network) and exercise every branch.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TestCase } from '@/types';

jest.mock('@/data/testCases', () => ({
  CATEGORIES: ['RCA', 'Alerts', 'Ops'],
  TEST_CASES: [],
  USE_CASES: [],
  default: [],
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn(),
  },
  asyncRunStorage: {
    getAllReports: jest.fn().mockResolvedValue([]),
    getReportCount: jest.fn().mockResolvedValue(0),
    getReportsByTestCase: jest.fn().mockResolvedValue({ reports: [], total: 0 }),
  },
}));

jest.mock('@/services/metrics', () => ({
  fetchBatchMetrics: jest.fn().mockResolvedValue({ metrics: [] }),
  formatCost: (v: number) => `$${v}`,
  formatDuration: (v: number) => `${v}ms`,
  formatTokens: (v: number) => `${v}`,
}));

// RunDetailsPanel (rendered only when a report is selected, which these
// tests never do) transitively imports react-markdown, an ESM-only package
// ts-jest's CJS transform can't parse. Stub it out so importing ReportsPage
// doesn't pull that chain in at all.
jest.mock('@/components/RunDetailsPanel', () => ({
  RunDetailsPanel: () => null,
}));

import { asyncTestCaseStorage } from '@/services/storage';
import { ReportsPage } from '@/components/ReportsPage';

const mockGetAll = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;

function makeTestCase(overrides: Partial<TestCase>): TestCase {
  return {
    id: 'tc-1',
    name: 'Some test case',
    description: '',
    initialPrompt: 'prompt',
    expectedOutcomes: [],
    category: 'RCA',
    context: [],
    versions: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    labels: [],
    currentVersion: 1,
    difficulty: 'Medium',
    ...overrides,
  } as TestCase;
}

async function renderWithDifficulties(difficulties: Array<'Easy' | 'Medium' | 'Hard'>) {
  mockGetAll.mockResolvedValue(
    difficulties.map((difficulty, i) => makeTestCase({ id: `tc-${i}`, name: `Case ${difficulty}`, difficulty }))
  );
  const utils = render(React.createElement(MemoryRouter, null, React.createElement(ReportsPage)));
  for (const difficulty of difficulties) {
    await waitFor(() => expect(screen.getByText(difficulty)).toBeTruthy());
  }
  return utils;
}

describe('ReportsPage difficulty badge (both themes, all 3 branches)', () => {
  it('Easy badge uses the light+dark blue token pairing, not the dark-only bg-blue-900/30', async () => {
    await renderWithDifficulties(['Easy']);
    const badge = screen.getByText('Easy');
    expect(badge.className).toContain('bg-blue-50');
    expect(badge.className).toContain('text-blue-700');
    expect(badge.className).toContain('dark:bg-blue-500/15');
    expect(badge.className).toContain('dark:text-blue-300');
    expect(badge.className).not.toMatch(/bg-blue-900\/30/);
  });

  it('Medium badge uses the light+dark yellow token pairing, not the dark-only bg-yellow-900/30', async () => {
    await renderWithDifficulties(['Medium']);
    const badge = screen.getByText('Medium');
    expect(badge.className).toContain('bg-yellow-50');
    expect(badge.className).toContain('text-yellow-800');
    expect(badge.className).toContain('dark:bg-yellow-500/15');
    expect(badge.className).toContain('dark:text-yellow-300');
    expect(badge.className).not.toMatch(/bg-yellow-900\/30/);
  });

  it('Hard badge uses the light+dark red token pairing, not the dark-only bg-red-900/30', async () => {
    await renderWithDifficulties(['Hard']);
    const badge = screen.getByText('Hard');
    expect(badge.className).toContain('bg-red-50');
    expect(badge.className).toContain('text-red-700');
    expect(badge.className).toContain('dark:bg-red-500/15');
    expect(badge.className).toContain('dark:text-red-300');
    expect(badge.className).not.toMatch(/bg-red-900\/30/);
  });

  it('all three badge classNames are identical whether or not the root has the dark class (CSS-driven, not JS-branched)', async () => {
    document.documentElement.classList.remove('dark');
    const light = await renderWithDifficulties(['Easy', 'Medium', 'Hard']);
    const lightClasses = ['Easy', 'Medium', 'Hard'].map((d) => screen.getByText(d).className);
    light.unmount();

    document.documentElement.classList.add('dark');
    await renderWithDifficulties(['Easy', 'Medium', 'Hard']);
    const darkClasses = ['Easy', 'Medium', 'Hard'].map((d) => screen.getByText(d).className);
    document.documentElement.classList.remove('dark');

    expect(darkClasses).toEqual(lightClasses);
  });
});
