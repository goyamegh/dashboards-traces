/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * @jest-environment jsdom
 */

/**
 * Unit tests for DeepDiveHeaderMetrics — the ComparisonDeepDive panel's
 * header: the case identity line ("Case: <name>", linked) plus the compact
 * "Score / Duration / Tools, A vs B" line that replaced the panel's removed
 * "Performance & Outcome" bars block.
 *
 * Covers: score formatting via the app's canonical `getRunOverallScore`
 * (percentage, not a bare number), duration formatting, tool-call counting
 * from the trajectory, the missing-value dash for every cell, and (owner
 * follow-up on #398) that the panel names the ONE test case it's actually
 * analyzing instead of presenting as if it were a run-level statistic.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  DeepDiveHeaderMetrics,
  DEEPDIVE_METRIC_DASH,
  formatScoreCell,
  formatDurationCell,
  formatToolsCell,
  type DeepDiveHeaderMetricsProps,
} from '@/components/comparison/DeepDiveHeaderMetrics';
import type { EvaluationReport, TrajectoryStep } from '@/types';

const h = React.createElement;

/** DeepDiveHeaderMetrics can render a react-router-dom <Link> — needs a Router in scope. */
function renderMetrics(props: DeepDiveHeaderMetricsProps) {
  return render(h(MemoryRouter, null, h(DeepDiveHeaderMetrics, props)));
}

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'rep-1',
    timestamp: '2026-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    agentName: 'agent',
    modelName: 'model',
    status: 'completed',
    trajectory: [],
    metrics: {},
    llmJudgeReasoning: '',
    ...overrides,
  } as EvaluationReport;
}

const actionStep = (id: string): TrajectoryStep => ({
  id,
  timestamp: 0,
  type: 'action',
  content: '',
  toolName: 'some_tool',
});

describe('formatScoreCell', () => {
  it('formats a single-metric (accuracy) report as a percentage, not a bare number', () => {
    expect(formatScoreCell({ accuracy: 100 })).toBe('100%');
    expect(formatScoreCell({ accuracy: 50 })).toBe('50%');
  });

  it('averages multiple populated metrics, matching RunScore/getRunOverallScore', () => {
    expect(formatScoreCell({ accuracy: 80, faithfulness: 60 })).toBe('70%');
  });

  it('renders a dash when there are no metrics at all', () => {
    expect(formatScoreCell({})).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatScoreCell(undefined)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatScoreCell(null)).toBe(DEEPDIVE_METRIC_DASH);
  });
});

describe('formatDurationCell', () => {
  it('formats sub-minute durations with one decimal of seconds', () => {
    expect(formatDurationCell(36900)).toBe('36.9s');
    expect(formatDurationCell(29200)).toBe('29.2s');
  });

  it('formats sub-second durations in ms', () => {
    expect(formatDurationCell(500)).toBe('500ms');
  });

  it('renders a dash for missing, non-finite, or negative durations', () => {
    expect(formatDurationCell(undefined)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatDurationCell(null)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatDurationCell(NaN)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatDurationCell(-1)).toBe(DEEPDIVE_METRIC_DASH);
  });
});

describe('formatToolsCell', () => {
  it('counts only trajectory steps of type "action"', () => {
    const report = makeReport({
      trajectory: [
        actionStep('a1'),
        { id: 'r1', timestamp: 0, type: 'response', content: 'done' },
        actionStep('a2'),
        actionStep('a3'),
      ],
    });
    expect(formatToolsCell(report)).toBe('3');
  });

  it('renders "0" (a real count) for an empty trajectory, not a dash', () => {
    expect(formatToolsCell(makeReport({ trajectory: [] }))).toBe('0');
  });

  it('renders a dash when the report or its trajectory is unknown', () => {
    expect(formatToolsCell(undefined)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatToolsCell(null)).toBe(DEEPDIVE_METRIC_DASH);
    expect(formatToolsCell(makeReport({ trajectory: undefined as unknown as TrajectoryStep[] }))).toBe(
      DEEPDIVE_METRIC_DASH
    );
  });
});

describe('DeepDiveHeaderMetrics (component)', () => {
  it('renders nothing when neither report nor case name is known', () => {
    const { container } = renderMetrics({ reportA: null, reportB: null });
    expect(container.firstChild).toBeNull();
  });

  it('renders the case name prominently, linked to the test case, ahead of the metrics line', () => {
    // Owner follow-up (#398): the deep-dive panel analyzes ONE representative
    // test case, but nothing said so -- prose like "Run A passed (100/100)"
    // reads like a run-level pass-rate stat. The panel header must name the
    // case it's actually analyzing.
    renderMetrics({
      reportA: makeReport({ metrics: { accuracy: 100 } }),
      reportB: makeReport({ metrics: { accuracy: 50 } }),
      testCaseName: 'Diagnose protected-index write rejection',
      testCaseId: 'tc-42',
    });
    const caseLabel = screen.getByTestId('deep-dive-case-label');
    expect(caseLabel.textContent).toContain('Case:');
    expect(caseLabel.textContent).toContain('Diagnose protected-index write rejection');
    const link = screen.getByRole('link', { name: /Diagnose protected-index write rejection/ });
    expect(link.getAttribute('href')).toBe('/evaluations/test-cases/tc-42');
  });

  it('renders the case name as plain (unlinked) text when no testCaseId is given', () => {
    renderMetrics({ reportA: null, reportB: null, testCaseName: 'Untitled case' });
    const caseLabel = screen.getByTestId('deep-dive-case-label');
    expect(caseLabel.textContent).toContain('Untitled case');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders the case name even when neither report has loaded yet', () => {
    const { container } = renderMetrics({ reportA: null, reportB: null, testCaseName: 'Case pending reports' });
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('deep-dive-case-label').textContent).toContain('Case pending reports');
    // No metrics line yet -- nothing to show until a report loads.
    expect(screen.queryByTestId('deep-dive-header-metrics')).toBeNull();
  });

  it('omits the case label entirely when no testCaseName is passed (metrics-only, back-compat)', () => {
    renderMetrics({
      reportA: makeReport({ metrics: { accuracy: 100 } }),
      reportB: makeReport({ metrics: { accuracy: 50 } }),
    });
    expect(screen.queryByTestId('deep-dive-case-label')).toBeNull();
    expect(screen.getByTestId('deep-dive-header-metrics')).toBeTruthy();
  });

  it('renders the full Score / Duration / Tools line for two known reports', () => {
    const reportA = makeReport({
      metrics: { accuracy: 100 },
      performanceMetrics: { durationMs: 36900, agentDurationMs: 36900 },
      trajectory: [actionStep('a1'), actionStep('a2'), actionStep('a3')],
    });
    const reportB = makeReport({
      metrics: { accuracy: 50 },
      performanceMetrics: { durationMs: 29200, agentDurationMs: 29200 },
      trajectory: [actionStep('b1'), actionStep('b2'), actionStep('b3')],
    });
    renderMetrics({ reportA, reportB });
    const line = screen.getByTestId('deep-dive-header-metrics');
    expect(line.textContent).toContain('Score:');
    expect(line.textContent).toContain('100%');
    expect(line.textContent).toContain('50%');
    expect(line.textContent).toContain('Duration:');
    expect(line.textContent).toContain('36.9s');
    expect(line.textContent).toContain('29.2s');
    expect(line.textContent).toContain('Tools:');
    // Both sides report 3 tool calls — assert the count appears twice separated by "vs".
    expect(line.textContent).toMatch(/Tools:\s*3\s*vs\s*3/);
    // Never a bare unlabeled score — every number sits after a "Score:"/"Duration:"/"Tools:" label.
    expect(line.textContent).not.toMatch(/^\s*100\s*\/\s*100/);
  });

  it('renders a dash for each missing metric when one report is absent', () => {
    const reportA = makeReport({
      metrics: { accuracy: 100 },
      performanceMetrics: { durationMs: 36900, agentDurationMs: 36900 },
      trajectory: [actionStep('a1')],
    });
    renderMetrics({ reportA, reportB: null });
    const line = screen.getByTestId('deep-dive-header-metrics');
    expect(line.textContent).toContain('100%');
    // Three missing-value dashes: score, duration, tools for the absent B side.
    const dashCount = (line.textContent?.match(new RegExp(DEEPDIVE_METRIC_DASH, 'g')) || []).length;
    expect(dashCount).toBe(3);
  });

  it('renders a dash for score when metrics are empty but still shows duration/tools', () => {
    const reportA = makeReport({
      metrics: {},
      performanceMetrics: { durationMs: 1000, agentDurationMs: 1000 },
      trajectory: [actionStep('a1')],
    });
    const reportB = makeReport({
      metrics: {},
      performanceMetrics: { durationMs: 2000, agentDurationMs: 2000 },
      trajectory: [],
    });
    renderMetrics({ reportA, reportB });
    const line = screen.getByTestId('deep-dive-header-metrics');
    const dashCount = (line.textContent?.match(new RegExp(DEEPDIVE_METRIC_DASH, 'g')) || []).length;
    expect(dashCount).toBe(2); // score A, score B
    expect(line.textContent).toContain('1.0s');
    expect(line.textContent).toContain('2.0s');
    expect(line.textContent).toMatch(/Tools:\s*1\s*vs\s*0/);
  });
});
