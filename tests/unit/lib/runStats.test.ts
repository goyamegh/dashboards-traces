/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { calculateRunStats, getReportIdsFromRun, bucketRunResults, computeRunStats } from '@/lib/runStats';
import type { BenchmarkRun, EvaluationReport } from '@/types';

describe('runStats', () => {
  describe('calculateRunStats', () => {
    it('should count passed and failed based on passFailStatus', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          passFailStatus: 'failed',
          trajectory: [],
          metrics: { accuracy: 50 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Needs work',
        } as EvaluationReport,
        'report-3': {
          id: 'report-3',
          testCaseId: 'tc-3',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 85 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Great',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(67); // 2/3 = 66.67% rounded
    });

    it('should treat pending and running results as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'pending' },
          'tc-3': { reportId: '', status: 'running' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(2);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(33); // 1/3 total test cases passed
    });

    it('should treat failed and cancelled results as failed', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'failed' },
          'tc-3': { reportId: '', status: 'cancelled' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(2);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(33); // 1/3 = 33.33% rounded
    });

    it('should treat missing reports as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Report not in map
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        // report-2 is missing
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('should treat trace mode pending metrics as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          metricsStatus: 'calculating', // Trace mode - waiting for traces
          trajectory: [],
          metrics: { accuracy: 0 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: '',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('should handle empty results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {},
      };

      const stats = calculateRunStats(run, {});

      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(0);
      expect(stats.passRate).toBe(0);
    });

    it('should treat undefined passFailStatus as failed', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          // passFailStatus is undefined
          trajectory: [],
          metrics: { accuracy: 50 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Unknown',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(1);
      expect(stats.total).toBe(1);
    });
  });

  describe('getReportIdsFromRun', () => {
    it('should extract all report IDs from run results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: '', status: 'pending' },
        },
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(2);
      expect(reportIds).toContain('report-1');
      expect(reportIds).toContain('report-2');
      expect(reportIds).not.toContain('');
    });

    it('should return empty array when no results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {},
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(0);
    });

    it('should handle undefined results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: undefined as any,
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(0);
    });

    it('should deduplicate report IDs', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-1', status: 'completed' }, // Same report ID
        },
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(1);
      expect(reportIds).toContain('report-1');
    });
  });

  describe('bucketRunResults', () => {
    // The single source of truth for pass/fail/errored counts (runs list AND
    // comparison), computed from persisted per-case verdicts — no reports.
    it('counts a completed result with no verdict as errored, not passed (#242)', () => {
      const b = bucketRunResults({
        a: { status: 'completed', passFailStatus: 'passed' },
        b: { status: 'completed', passFailStatus: 'passed' },
        c: { status: 'completed' }, // judge errored — no verdict persisted
      });
      expect(b).toEqual({ passed: 2, failed: 0, errored: 1, pending: 0, total: 3 });
    });

    it('buckets failed/cancelled as failed and pending/running as pending', () => {
      const b = bucketRunResults({
        a: { status: 'completed', passFailStatus: 'passed' },
        b: { status: 'failed', passFailStatus: 'failed' },
        c: { status: 'cancelled' },
        d: { status: 'running' },
        e: { status: 'pending' },
      });
      expect(b).toEqual({ passed: 1, failed: 2, errored: 0, pending: 2, total: 5 });
    });

    it('handles empty/undefined results', () => {
      expect(bucketRunResults({})).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
      expect(bucketRunResults(undefined)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
    });
  });

  describe('computeRunStats', () => {
    it('prefers recomputing from run.results over a stale/wrong denormalized run.stats (#242)', () => {
      // run.stats.passed is stale/wrong (e.g. written by the old naive
      // aggregator that counted every "completed" result as passed) — one
      // case has no verdict (judge errored) so the true passed count is 1,
      // not 2.
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          a: { status: 'completed', passFailStatus: 'passed' },
          b: { status: 'completed' }, // judge errored, no verdict
        },
        stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 },
      } as BenchmarkRun;

      expect(computeRunStats(run)).toEqual({ passed: 1, failed: 0, errored: 1, total: 2 });
    });

    it('falls back to the denormalized run.stats when run.results is empty (old runs)', () => {
      const run: BenchmarkRun = {
        id: 'run-2',
        name: 'Old Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {},
        stats: { passed: 3, failed: 1, pending: 0, errored: 0, total: 4 },
      } as BenchmarkRun;

      expect(computeRunStats(run)).toEqual({ passed: 3, failed: 1, errored: 0, total: 4 });
    });

    it('returns all-zero stats when neither results nor stats are present', () => {
      const run: BenchmarkRun = {
        id: 'run-3',
        name: 'Empty Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
      } as BenchmarkRun;

      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, total: 0 });
    });
  });
});
