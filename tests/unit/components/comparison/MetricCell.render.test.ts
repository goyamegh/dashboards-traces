/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for MetricCell's per-case accuracy chip — the fabricated-0%
 * regression found on a real STaRK-retail comparison (two runs scored by a
 * custom evaluator whose reports carry ONLY custom metric keys like
 * fact_precision / provenance_verifiability and no `metrics.accuracy`).
 * The old `result.accuracy ?? 0` fallback rendered "Passed 0%" / "Failed 0%"
 * in EVERY table cell of such comparisons.
 *
 *  - no numeric accuracy  -> NO accuracy chip at all (status label only)
 *  - accuracy === 0       -> real "0%" (a genuine zero score still shows)
 *  - accuracy present     -> value + delta vs baseline
 *  - accuracy missing     -> no delta chip even when a baseline exists
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MetricCell } from '@/components/comparison/MetricCell';
import type { TestCaseRunResult } from '@/types';

function makeResult(overrides: Partial<TestCaseRunResult> = {}): TestCaseRunResult {
  return {
    reportId: 'report-1',
    status: 'completed',
    passFailStatus: 'passed',
    ...overrides,
  } as TestCaseRunResult;
}

function renderCell(props: { result: TestCaseRunResult; baselineAccuracy?: number }) {
  return render(React.createElement(MetricCell, props));
}

describe('MetricCell accuracy chip (fabricated-0% regression)', () => {
  it('omits the accuracy chip entirely when the report carries no numeric accuracy (custom-evaluator shape)', () => {
    renderCell({ result: makeResult({ accuracy: undefined }) });
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
    // The pre-fix symptom: a literal "0%" chip.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('renders a real accuracy of 0 as "0%" (zero is a score, not "missing")', () => {
    renderCell({ result: makeResult({ accuracy: 0, passFailStatus: 'failed' }) });
    const chip = screen.getByTestId('metric-cell-accuracy');
    expect(chip.textContent).toBe('0%');
  });

  it('renders the accuracy value and a delta against the baseline', () => {
    renderCell({ result: makeResult({ accuracy: 95.5 }), baselineAccuracy: 90 });
    expect(screen.getByTestId('metric-cell-accuracy').textContent).toBe('95.5%');
    expect(screen.getByText('+5.5')).toBeTruthy();
  });

  it('suppresses the delta when accuracy is missing even if a baseline exists', () => {
    renderCell({ result: makeResult({ accuracy: undefined }), baselineAccuracy: 90 });
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
    // No "-90" fabricated delta.
    expect(screen.queryByText(/-90/)).toBeNull();
  });

  it('never renders an accuracy chip for the errored bucket (metricsStatus error)', () => {
    renderCell({ result: makeResult({ errored: true, accuracy: 0 }) });
    expect(screen.getByText('Errored')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });
});

/**
 * Render tests for MetricCell's PRIMARY RUBRIC fallback chip — owner spec:
 * "the percentage of the rubric for each test case should show the primary
 * rubric". When a report carries no `metrics.accuracy` (custom evaluators),
 * the cell falls back to showing the report's primary rubric (see
 * services/comparisonService.ts `getPrimaryRubric`) instead of a bare
 * verdict with no number at all.
 */
describe('MetricCell primary-rubric fallback chip', () => {
  it('shows the primary rubric name + value when accuracy is absent but a primary rubric exists', () => {
    renderCell({ result: makeResult({ accuracy: undefined, primaryRubric: { key: 'fact_precision', value: 72 } }) });
    const chip = screen.getByTestId('metric-cell-primary-rubric');
    expect(chip.textContent).toBe('fact_precision72%');
    expect(chip.title).toContain('fact_precision');
    // Still no fabricated accuracy chip.
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });

  it('renders nothing extra when neither accuracy nor a primary rubric is present', () => {
    renderCell({ result: makeResult({ accuracy: undefined }) });
    expect(screen.queryByTestId('metric-cell-primary-rubric')).toBeNull();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });

  it('does NOT render the primary-rubric chip when accuracy IS present (accuracy takes precedence)', () => {
    renderCell({ result: makeResult({ accuracy: 88, primaryRubric: { key: 'fact_precision', value: 72 } }) });
    expect(screen.getByTestId('metric-cell-accuracy').textContent).toBe('88%');
    expect(screen.queryByTestId('metric-cell-primary-rubric')).toBeNull();
  });

  it('never renders the primary-rubric chip for the errored bucket', () => {
    renderCell({ result: makeResult({ errored: true, accuracy: undefined, primaryRubric: { key: 'fact_precision', value: 72 } }) });
    expect(screen.getByText('Errored')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-primary-rubric')).toBeNull();
  });

  it('rounds the primary rubric value to one decimal like accuracy', () => {
    renderCell({ result: makeResult({ accuracy: undefined, primaryRubric: { key: 'abstention_integrity', value: 72.04 } }) });
    expect(screen.getByTestId('metric-cell-primary-rubric').textContent).toBe('abstention_integrity72%');
  });
});
