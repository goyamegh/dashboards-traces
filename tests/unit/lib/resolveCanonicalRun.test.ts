/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for resolveCanonicalEvaluationRun -- the extracted, reusable
 * "prefer the first-class EvaluationRun doc over the embedded
 * BenchmarkRun projection when it exists" resolution (see
 * components/evals3/RunInspectorPage.tsx, the first caller).
 */

import { resolveCanonicalEvaluationRun } from '@/lib/resolveCanonicalRun';
import type { BenchmarkRun, EvaluationRun } from '@/types';

const embeddedProjection: BenchmarkRun = {
  id: 'run-1',
  name: 'Run 1',
  createdAt: '2024-01-01T00:00:00Z',
  agentKey: 'demo',
  modelId: 'model-1',
  results: {},
};

const firstClassDoc: EvaluationRun = {
  id: 'run-1',
  docType: 'evaluation-run',
  name: 'Run 1',
  createdAt: '2024-01-01T00:00:00Z',
  status: 'completed',
  agentKey: 'demo',
  modelId: 'model-1',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [],
  results: {},
};

describe('resolveCanonicalEvaluationRun', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('prefers the first-class EvaluationRun doc when the fetch succeeds', async () => {
    const fetchFn = jest.fn().mockResolvedValue(firstClassDoc);
    const result = await resolveCanonicalEvaluationRun('run-1', embeddedProjection, fetchFn);
    expect(result).toBe(firstClassDoc);
    expect(fetchFn).toHaveBeenCalledWith('run-1');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the embedded projection SILENTLY on a 404 (no first-class doc, e.g. pre-#399 legacy run)', async () => {
    const err = new Error('Failed to get evaluation run: Not Found') as Error & { status?: number };
    err.status = 404;
    const fetchFn = jest.fn().mockRejectedValue(err);
    const result = await resolveCanonicalEvaluationRun('run-1', embeddedProjection, fetchFn);
    expect(result).toBe(embeddedProjection);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the embedded projection but LOGS a warning on a non-404 failure (does not mask a real error as "not found")', async () => {
    const err = new Error('Failed to get evaluation run: Internal Server Error') as Error & { status?: number };
    err.status = 500;
    const fetchFn = jest.fn().mockRejectedValue(err);
    const result = await resolveCanonicalEvaluationRun('run-1', embeddedProjection, fetchFn);
    expect(result).toBe(embeddedProjection);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('run-1');
  });

  it('logs a warning on a network error with no status property at all', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await resolveCanonicalEvaluationRun('run-1', embeddedProjection, fetchFn);
    expect(result).toBe(embeddedProjection);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the embedded projection when the fetch resolves falsy (test-double edge case)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(undefined as unknown as EvaluationRun);
    const result = await resolveCanonicalEvaluationRun('run-1', embeddedProjection, fetchFn);
    expect(result).toBe(embeddedProjection);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
