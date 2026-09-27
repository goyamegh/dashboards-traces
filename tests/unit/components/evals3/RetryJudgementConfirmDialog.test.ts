/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RetryJudgementConfirmDialog — async + pre-flight behaviour:
 *   - opening pre-flights the retry; a deterministic evaluator that can score
 *     nothing disables Confirm and lists the grouped reasons + per-case
 *     diagnostics ("this doesn't show the right error");
 *   - Confirm resolves on the 202 and the dialog can be closed while the
 *     job runs (no cancel); re-opening shows live progress, not a fresh form;
 *   - a job finishing while open shows "Retried n · x scored · y not
 *     evaluable" with reasons, amber not red.
 */

import * as React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RetryJudgementConfirmDialog } from '@/components/evals3/RetryJudgementConfirmDialog';
import { __resetRetryJudgementJobsForTests, getRetryJudgementJob, RETRY_JUDGEMENT_JOB_POLL_MS } from '@/services/client/retryJudgementJobs';
import type { EvaluationRun } from '@/types';

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body });

const run = { id: 'run-d', name: 'Det run', judgeModelId: 'demo-judge', evaluatorId: 'eval-det', status: 'completed', results: {} } as unknown as EvaluationRun;

const NO_GOLD = 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)';
const NO_CANDIDATES = 'no candidate ids found in the final answer, a results tool or the stored tool results';
const diagnostics = {
  gold: { source: 'expectedOutcomes[0]', ids: ['428457'], explicitlyEmpty: false },
  candidates: {
    sourceTried: [
      { source: 'response-results', count: 0, detail: 'final response (no ranked list recognised)' },
      { source: 'tool-hits', count: 0, detail: "tool 'search' hits (hits / results)" },
      { source: 'generic-scan', count: 0, detail: "every 'id' / '_id' value in 1 tool result (weak)" },
    ],
    sourceUsed: 'none', count: 0, anchorRemoved: 0, returned: false, weak: false,
  },
  toolsScanned: ['search'],
};
const preflightNothing = {
  evaluatorId: 'eval-det', evaluatorName: 'Ranked retrieval', deterministic: true, scope: 'all', total: 3, evaluable: 0, notEvaluable: 3, abstain: 0,
  reasons: { [NO_GOLD]: 2, [NO_CANDIDATES]: 1 },
  cases: [
    { testCaseId: 'tc-1', evaluable: false, reason: NO_GOLD, diagnostics: { ...diagnostics, gold: { source: 'not declared', ids: [], explicitlyEmpty: false } } },
    { testCaseId: 'tc-2', evaluable: false, reason: NO_GOLD, diagnostics: { ...diagnostics, gold: { source: 'not declared', ids: [], explicitlyEmpty: false } } },
    { testCaseId: 'tc-3', evaluable: false, reason: NO_CANDIDATES, diagnostics },
  ],
};
const preflightSome = { ...preflightNothing, evaluable: 2, notEvaluable: 1, abstain: 1, reasons: { [NO_CANDIDATES]: 1 }, cases: [{ testCaseId: 'tc-1', evaluable: true }, { testCaseId: 'tc-2', evaluable: true, abstain: true }, preflightNothing.cases[2]] };
const preflightLlm = { evaluatorId: 'eval-llm', evaluatorName: 'LLM judge', deterministic: false, scope: 'errored', total: 2, evaluable: 2, notEvaluable: 0, abstain: 0, reasons: {}, cases: [] };

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function renderDialog(props: Partial<React.ComponentProps<typeof RetryJudgementConfirmDialog>> = {}) {
  const onOpenChange = jest.fn();
  const utils = render(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, {
    run, count: 2, open: true, onOpenChange, onComplete: () => {}, ...props,
  })));
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  __resetRetryJudgementJobsForTests();
});
afterEach(() => { jest.useRealTimers(); });

/** The hook's mount-time adopt() + the dialog's pre-flight, in mount order. */
const primeOpen = (preflight: unknown) => {
  fetchMock
    .mockResolvedValueOnce(json(404, { error: 'No retry-judgement job found for this run' })) // adopt()
    .mockResolvedValueOnce(json(200, preflight)); // preflight
};

describe('RetryJudgementConfirmDialog — pre-flight', () => {
  it('an evaluator that fits nothing: "0 of 3 cases evaluable", grouped reasons, per-case diagnostics, Confirm DISABLED', async () => {
    primeOpen(preflightNothing);
    renderDialog();
    expect(screen.getByTestId('retry-judgement-preflight-loading')).toBeTruthy();
    await flush();

    const pre = screen.getByTestId('retry-judgement-preflight');
    expect(pre.getAttribute('data-evaluable')).toBe('0');
    expect(screen.getByTestId('retry-judgement-preflight-summary').textContent).toBe('0 of 3 cases evaluable by this evaluator');
    expect(screen.getByTestId('retry-judgement-preflight-reasons').textContent).toContain(`2 ×${NO_GOLD}`);
    expect(screen.getByTestId('retry-judgement-preflight-reasons').textContent).toContain(`1 ×${NO_CANDIDATES}`);
    expect(pre.textContent).toContain("This evaluator's gold/extraction rules don't match these cases — pick another evaluator or add gold ids.");
    // Amber, not red.
    expect(pre.className).toMatch(/amber/);
    expect(pre.className).not.toMatch(/red/);
    // Per-case diagnostics render the gold source and every candidate source tried.
    const tc3 = screen.getByTestId('retry-judgement-preflight-cases-tc-3');
    expect(tc3.textContent).toContain('gold 1 id from expectedOutcomes[0]');
    expect(tc3.textContent).toContain("0 from tool 'search' hits (hits / results)");
    expect(tc3.textContent).toContain('Tools scanned: search');
    expect(screen.getByTestId('retry-judgement-preflight-cases-tc-1').textContent).toContain('gold not declared');

    const confirm = screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('title')).toBe('This evaluator cannot score any case of this run');
    // The pre-flight POSTed the same body the retry would.
    expect(fetchMock.mock.calls[1][0]).toBe('/api/storage/evaluation-runs/run-d/retry-judgement/preflight');
    // Deterministic wording in the form.
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');
    expect(screen.getByText('Ranked retrieval')).toBeTruthy();
  });

  it('a partially evaluable evaluator: "2 of 3", abstain count, reasons, Confirm ENABLED and sends scope all', async () => {
    primeOpen(preflightSome);
    renderDialog();
    await flush();
    expect(screen.getByTestId('retry-judgement-preflight-summary').textContent).toBe('2 of 3 cases evaluable by this evaluator');
    expect(screen.getByTestId('retry-judgement-preflight-abstain').textContent).toContain('1 abstain case');
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(json(202, { total: 3 }));
    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    const post = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/retry-judgement?scope=all'));
    expect(post).toBeTruthy();
    expect(JSON.parse(post![1].body)).toEqual({ scope: 'all' });
  });

  it('an LLM evaluator: no evaluability banner, legacy wording, Confirm enabled with the judge-failed count', async () => {
    primeOpen(preflightLlm);
    renderDialog();
    await flush();
    expect(screen.queryByTestId('retry-judgement-preflight')).toBeNull();
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('2');
    expect(screen.getByText('demo-judge')).toBeTruthy();
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a pre-flight failure does not block the retry', async () => {
    fetchMock.mockResolvedValueOnce(json(404, {})).mockResolvedValueOnce(json(500, { error: 'boom' }));
    renderDialog();
    await flush();
    expect(screen.getByTestId('retry-judgement-preflight-error').textContent).toContain('boom');
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('passes the selected evaluatorId to the pre-flight and the retry', async () => {
    primeOpen(preflightSome);
    renderDialog({ evaluatorId: 'eval-picked' });
    await flush();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ evaluatorId: 'eval-picked' });
    fetchMock.mockResolvedValueOnce(json(202, { total: 3 }));
    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    const post = fetchMock.mock.calls.find(c => String(c[0]).includes('/retry-judgement?scope='));
    expect(JSON.parse(post![1].body)).toEqual({ scope: 'all', evaluatorId: 'eval-picked' });
  });
});

describe('RetryJudgementConfirmDialog — async job', () => {
  it('Confirm → 202 → live progress; Close keeps the job running; re-open shows the progress, not a fresh form; completion shows the not-evaluable summary', async () => {
    primeOpen(preflightSome);
    const { onOpenChange, rerender } = renderDialog();
    await flush();

    fetchMock.mockResolvedValueOnce(json(202, { total: 3 }));
    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    expect(screen.getByTestId('retry-judgement-progress-text').textContent).toBe('Re-judging 0/3…');
    expect(screen.getByTestId('retry-judgement-progress').textContent).toContain('you can close this dialog');
    expect(screen.queryByTestId('retry-judgement-confirm-btn')).toBeNull();

    // Close while running — the job survives in the store.
    fireEvent.click(screen.getByTestId('retry-judgement-close-btn'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, { run, count: 2, open: false, onOpenChange, onComplete: () => {} })));
    expect(getRetryJudgementJob('run-d')!.status).toBe('running');

    // Progress arrives while closed.
    fetchMock.mockResolvedValueOnce(json(200, { status: 'running', total: 3, completed: 2 }));
    await act(async () => { jest.advanceTimersByTime(RETRY_JUDGEMENT_JOB_POLL_MS); });
    await flush();

    // Re-open: live progress (2/3), no form. The re-open pre-flights again (harmless).
    fetchMock.mockResolvedValueOnce(json(200, preflightSome));
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, { run, count: 2, open: true, onOpenChange, onComplete: () => {} })));
    await flush();
    expect(screen.getByTestId('retry-judgement-progress-text').textContent).toBe('Re-judging 2/3…');
    expect(screen.queryByTestId('retry-judgement-confirm-btn')).toBeNull();

    // Completion → summary with the not-evaluable group, amber, with the hint and per-case diagnostics.
    const summary = {
      retried: 3, succeeded: 2, failed: 0, notEvaluable: 1, abstain: 1,
      results: [
        { testCaseId: 'tc-1', reportId: 'r1', outcome: 'succeeded', passFailStatus: 'passed' },
        { testCaseId: 'tc-2', reportId: 'r2', outcome: 'succeeded', passFailStatus: 'passed', abstain: true },
        { testCaseId: 'tc-3', reportId: 'r3', outcome: 'not-evaluable', passFailStatus: null, reason: NO_CANDIDATES, diagnostics },
      ],
    };
    fetchMock.mockResolvedValueOnce(json(200, { status: 'completed', total: 3, completed: 3, summary }));
    await act(async () => { jest.advanceTimersByTime(RETRY_JUDGEMENT_JOB_POLL_MS); });
    await flush();
    expect(screen.getByTestId('retry-judgement-summary-line').textContent).toBe('Retried 3 · 2 scored (1 abstain) · 1 not evaluable');
    const notEvaluable = screen.getByTestId('retry-judgement-summary-not-evaluable');
    expect(notEvaluable.className).toMatch(/amber/);
    expect(screen.getByTestId('retry-judgement-summary-reasons').textContent).toBe(`1 ×${NO_CANDIDATES}`);
    expect(screen.getByTestId('retry-judgement-summary-cases-tc-3').textContent).toContain("0 from tool 'search' hits");
    expect(notEvaluable.textContent).toContain('pick another evaluator or add gold ids');
    expect(screen.queryByText(/still failed/)).toBeNull();
    fireEvent.click(screen.getByTestId('retry-judgement-done-btn'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('a refused POST shows the server error inline and leaves the form usable', async () => {
    primeOpen(preflightLlm);
    renderDialog();
    await flush();
    fetchMock.mockResolvedValueOnce(json(409, { error: 'Retry judgement is already in progress for this run' }));
    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    expect(screen.getByTestId('retry-judgement-error').textContent).toBe('Retry judgement is already in progress for this run');
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(getRetryJudgementJob('run-d')).toBeUndefined();
  });
});
