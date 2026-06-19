/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenSearchObservabilityModule } from '@/server/adapters/observability/OpenSearchObservabilityModule';
import { fetchTraces, checkTracesHealth } from '@/server/services/tracesService';
import { fetchLogs } from '@/server/services/logsService';
import { computeMetrics, computeBatchMetrics } from '@/server/services/metricsService';

jest.mock('@/server/services/tracesService', () => ({
  fetchTraces: jest.fn(),
  checkTracesHealth: jest.fn(),
}));
jest.mock('@/server/services/logsService', () => ({
  fetchLogs: jest.fn(),
}));
jest.mock('@/server/services/metricsService', () => ({
  computeMetrics: jest.fn(),
  computeBatchMetrics: jest.fn(),
  getPricing: jest.fn(() => ({ input: 3, output: 15 })),
}));

const mockFetchTraces = fetchTraces as jest.MockedFunction<typeof fetchTraces>;
const mockCheckTracesHealth = checkTracesHealth as jest.MockedFunction<typeof checkTracesHealth>;
const mockFetchLogs = fetchLogs as jest.MockedFunction<typeof fetchLogs>;
const mockComputeMetrics = computeMetrics as jest.MockedFunction<typeof computeMetrics>;
const mockComputeBatchMetrics = computeBatchMetrics as jest.MockedFunction<typeof computeBatchMetrics>;

describe('OpenSearchObservabilityModule', () => {
  const client = { search: jest.fn() } as any;
  const indexes = { traces: 'otel-traces-*', logs: 'ml-logs-*', metrics: 'otel-metrics-*' };
  let mod: OpenSearchObservabilityModule;

  beforeEach(() => {
    jest.clearAllMocks();
    mod = new OpenSearchObservabilityModule(client, indexes);
  });

  it('is always configured', () => {
    expect(mod.isConfigured()).toBe(true);
  });

  describe('traces.query', () => {
    it('delegates to fetchTraces with the bound client + traces index and maps pagination', async () => {
      mockFetchTraces.mockResolvedValue({
        spans: [{ traceId: 't1', spanId: 's1' } as any],
        total: 1,
        nextCursor: 'cur',
        hasMore: true,
      });

      const result = await mod.traces.query({ traceId: 't1', size: 50 });

      expect(mockFetchTraces).toHaveBeenCalledWith(
        { traceId: 't1', size: 50 },
        client,
        'otel-traces-*'
      );
      expect(result).toEqual({
        spans: [{ traceId: 't1', spanId: 's1' }],
        total: 1,
        nextCursor: 'cur',
        hasMore: true,
      });
    });

    it('defaults nextCursor=null / hasMore=false when the service omits them', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);

      const result = await mod.traces.query({ runIds: ['r1'] });

      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });
  });

  describe('traces.getByTraceId / getByRunIds', () => {
    it('getByTraceId queries by the single trace id', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [{ traceId: 'tx' } as any], total: 1 } as any);

      const spans = await mod.traces.getByTraceId('tx');

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'tx' }),
        client,
        'otel-traces-*'
      );
      expect(spans).toEqual([{ traceId: 'tx' }]);
    });

    it('getByRunIds short-circuits to [] for an empty list (no query)', async () => {
      const spans = await mod.traces.getByRunIds([]);
      expect(spans).toEqual([]);
      expect(mockFetchTraces).not.toHaveBeenCalled();
    });

    it('getByRunIds queries by the run ids', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);
      await mod.traces.getByRunIds(['r1', 'r2']);
      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ runIds: ['r1', 'r2'] }),
        client,
        'otel-traces-*'
      );
    });
  });

  describe('logs.query', () => {
    it('delegates to fetchLogs with the bound client + logs index', async () => {
      mockFetchLogs.mockResolvedValue({ logs: [{ id: 'l1' } as any], total: 1 } as any);

      const result = await mod.logs.query({ runId: 'run-1' });

      expect(mockFetchLogs).toHaveBeenCalledWith({ runId: 'run-1' }, client, 'ml-logs-*');
      expect(result).toEqual({ logs: [{ id: 'l1' }], total: 1 });
    });
  });

  describe('metrics', () => {
    it('is supported on the OpenSearch backend', () => {
      expect(mod.metrics.supported).toBe(true);
    });

    it('computeForRun delegates to computeMetrics with the bound client + traces index', async () => {
      mockComputeMetrics.mockResolvedValue({ runId: 'run-1', totalTokens: 1500 } as any);
      const m = await mod.metrics.computeForRun('run-1');
      expect(mockComputeMetrics).toHaveBeenCalledWith('run-1', { client, indexPattern: 'otel-traces-*' });
      expect(m).toEqual({ runId: 'run-1', totalTokens: 1500 });
    });

    it('computeForRuns delegates to computeBatchMetrics', async () => {
      mockComputeBatchMetrics.mockResolvedValue([{ runId: 'run-1' } as any, { runId: 'run-2' } as any]);
      const ms = await mod.metrics.computeForRuns(['run-1', 'run-2']);
      expect(mockComputeBatchMetrics).toHaveBeenCalledWith(['run-1', 'run-2'], { client, indexPattern: 'otel-traces-*' });
      expect(ms).toHaveLength(2);
    });

    it('computeForRuns short-circuits to [] for an empty list', async () => {
      const ms = await mod.metrics.computeForRuns([]);
      expect(ms).toEqual([]);
      expect(mockComputeBatchMetrics).not.toHaveBeenCalled();
    });

    it('computeOverview fetches spans for the window and aggregates per service', async () => {
      mockFetchTraces.mockResolvedValue({
        spans: [
          { traceId: 't1', spanId: 's1', name: 'claude_code.llm_request', status: 'OK', attributes: { 'service.name': 'claude-code-agent', 'session.id': 'a', model: 'opus', input_tokens: 100, output_tokens: 50 } },
          { traceId: 't1', spanId: 's2', name: 'claude_code.tool.execution', status: 'OK', attributes: { 'service.name': 'claude-code-agent', 'session.id': 'a', tool_name: 'Bash' } },
        ],
        total: 2,
      } as any);

      const ov = await mod.metrics.computeOverview({ startTime: 1, endTime: 2 });

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ startTime: 1, endTime: 2 }),
        client,
        'otel-traces-*'
      );
      expect(ov!.services).toHaveLength(1);
      expect(ov!.services[0].service).toBe('claude-code-agent');
      expect(ov!.services[0].llmCalls).toBe(1);
      expect(ov!.services[0].toolCalls).toBe(1);
      expect(ov!.services[0].inputTokens).toBe(100);
      expect(ov!.capped).toBe(false);
    });
  });

  describe('health', () => {
    it('delegates to checkTracesHealth on the traces index', async () => {
      mockCheckTracesHealth.mockResolvedValue({ status: 'ok', index: 'otel-traces-*' });
      const health = await mod.health();
      expect(mockCheckTracesHealth).toHaveBeenCalledWith(client, 'otel-traces-*');
      expect(health).toEqual({ status: 'ok', index: 'otel-traces-*' });
    });

    it('surfaces an error health result (no fallback)', async () => {
      mockCheckTracesHealth.mockResolvedValue({
        status: 'error',
        error: 'boom',
        errorCategory: 'connection',
        suggestion: 'check cluster',
      });
      const health = await mod.health();
      expect(health.status).toBe('error');
      expect(health.errorCategory).toBe('connection');
    });
  });
});
