/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-error surfacing — UI primitives:
 *   - ResultStatus: an agent-stage failure is `errored` (not a failed
 *     verdict) and the badge reads AGENT ERROR.
 *   - AgentFailureCard: the Test Case Output card shows the unwrapped cause,
 *     endpoint, elapsed, HTTP status and the re-run remedy.
 *   - TestCaseInspectorPanel header badge: AGENT ERROR vs ERRORED.
 */

import * as React from 'react';
const h = React.createElement;
import { render, screen } from '@testing-library/react';
import { getResultStatus, isAgentError, StatusLabel, StatusIcon, getStatusDescription } from '@/components/evals3/ResultStatus';
import { AgentFailureCard } from '@/components/evals3/AgentFailureCard';
import type { EvaluationReport } from '@/types';

jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: () => require('react').createElement('div', { 'data-testid': 'run-details-content' }),
}));
jest.mock('@/components/evals3/CollapsibleTestCaseDefinition', () => ({
  CollapsibleTestCaseDefinition: () => null,
}));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual('@/lib/utils'),
  getRunDisplayName: () => 'Run abc',
}));

import { TestCaseInspectorPanel } from '@/components/evals3/TestCaseInspectorPanel';

const CAUSE = 'HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT) (http://localhost:8000/ask)';
const agentFailedReport = {
  id: 'r-agent', timestamp: new Date().toISOString(), agentName: 'A REST agent', modelName: 'm', testCaseId: 'tc',
  status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
  trajectory: [], rawEvents: [], metrics: {},
  error: CAUSE,
  agentError: { kind: 'timeout', message: CAUSE, elapsedMs: 300_728, endpoint: 'http://localhost:8000/ask' },
  traceError: `Agent request failed (kind=agent_failed): ${CAUSE}`,
  llmJudgeReasoning: '**Agent request failed — not judged.**',
  connectorProtocol: 'rest',
} as unknown as EvaluationReport;

const judgeFailedReport = {
  id: 'r-judge', timestamp: new Date().toISOString(), agentName: 'A REST agent', modelName: 'm', testCaseId: 'tc',
  status: 'completed', metricsStatus: 'error', failureStage: 'judge', passFailStatus: null,
  trajectory: [{ id: 's1', type: 'response', content: 'answer', timestamp: 1 }], rawEvents: [{}], metrics: {},
  error: 'Bedrock Judge evaluation failed after 10 attempts: empty reply',
  traceError: 'Judge evaluation failed (kind=judge_failed): empty reply',
  llmJudgeReasoning: '**Evaluator could not run.**',
} as unknown as EvaluationReport;

describe('ResultStatus — agent-error aware errored status', () => {
  it('an agent-stage failure with run status "failed" is errored (excluded from pass-rate), not a failed verdict', () => {
    const status = getResultStatus({ status: 'failed' } as any, agentFailedReport);
    expect(status).toBe('errored');
    expect(isAgentError(status, agentFailedReport)).toBe(true);
  });
  it('a plain execution failure without a report is still failed', () => {
    expect(getResultStatus({ status: 'failed' } as any, null)).toBe('failed');
  });
  it('a judge-stage failure is errored but not an agent error', () => {
    const status = getResultStatus({ status: 'completed' } as any, judgeFailedReport);
    expect(status).toBe('errored');
    expect(isAgentError(status, judgeFailedReport)).toBe(false);
  });
  it('StatusLabel reads AGENT ERROR only for agent errors; StatusIcon uses a distinct icon', () => {
    const { unmount } = render(h(StatusLabel, { status: 'errored', agentError: true }));
    expect(screen.getByTestId('status-label').textContent).toBe('AGENT ERROR');
    unmount();
    render(h(StatusLabel, { status: 'errored' }));
    expect(screen.getByTestId('status-label').textContent).toBe('ERRORED');
    render(h(StatusIcon, { status: 'errored', agentError: true }));
    expect(screen.getByTestId('status-icon-agent-error')).toBeTruthy();
  });
  it('getStatusDescription names the stage', () => {
    expect(getStatusDescription('errored', true)).toMatch(/Agent request failed/);
    expect(getStatusDescription('errored')).toBe('Evaluator could not run');
  });
});

describe('AgentFailureCard', () => {
  it('shows the unwrapped cause, endpoint, elapsed, connector and the re-run remedy', () => {
    render(h(AgentFailureCard, { report: agentFailedReport }));
    expect(screen.getByTestId('run-failure-card').getAttribute('data-stage')).toBe('agent');
    expect(screen.getByText(/Agent request failed — agent request timed out/)).toBeTruthy();
    expect(screen.getByTestId('run-failure-cause').textContent).toMatch(/UND_ERR_HEADERS_TIMEOUT/);
    expect(screen.getByText('http://localhost:8000/ask')).toBeTruthy();
    expect(screen.getByText('5 min 1 s')).toBeTruthy();
    expect(screen.getByText('rest')).toBeTruthy();
    expect(screen.getByText(/produced no output, so this case was not judged\. Re-run the case/)).toBeTruthy();
    expect(screen.queryByText(/Evaluator could not run/)).toBeNull();
  });
  it('shows the HTTP status for a non-2xx agent reply', () => {
    const r = { ...agentFailedReport, agentError: { kind: 'http_500', message: 'REST request failed: 500 - boom', httpStatus: 500, elapsedMs: 271_000, endpoint: 'http://a/b' } } as any;
    render(h(AgentFailureCard, { report: r }));
    expect(screen.getByText(/agent returned HTTP 500/)).toBeTruthy();
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getByText('4 min 31 s')).toBeTruthy();
  });
  it('renders nothing for judge-stage or healthy reports', () => {
    expect(render(h(AgentFailureCard, { report: judgeFailedReport })).container.firstChild).toBeNull();
    const healthy = { ...judgeFailedReport, failureStage: undefined, metricsStatus: 'ready', passFailStatus: 'passed' } as any;
    expect(render(h(AgentFailureCard, { report: healthy })).container.firstChild).toBeNull();
  });
});

describe('TestCaseInspectorPanel — header badge', () => {
  it('reads AGENT ERROR for an agent-stage failure', () => {
    render(h(TestCaseInspectorPanel, { report: agentFailedReport, testCase: null, status: 'errored' }));
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('AGENT ERROR');
  });
  it('reads ERRORED for a judge-stage failure', () => {
    render(h(TestCaseInspectorPanel, { report: judgeFailedReport, testCase: null, status: 'errored' }));
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('ERRORED');
  });
  it('still reads FAILED for a failed verdict', () => {
    const verdict = { ...judgeFailedReport, failureStage: undefined, metricsStatus: 'ready', traceError: undefined, passFailStatus: 'failed' } as any;
    render(h(TestCaseInspectorPanel, { report: verdict, testCase: null, status: 'failed' }));
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('FAILED');
  });
});
