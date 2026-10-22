/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Observability Module
 *
 * IObservabilityModule backed by an OpenSearch cluster holding OTel
 * Data Prepper indices. Wraps the DSL-building services
 * (tracesService / logsService / metricsService) behind the backend-neutral
 * adapter interface so routes never touch an OpenSearch Client directly.
 */

import { Client } from '@opensearch-project/opensearch';
import type {
  IObservabilityModule,
  ILogsOperations,
  ITracesOperations,
  IMetricsOperations,
  TracesQueryOptions,
  LogsQueryOptions,
  ObservabilityBackendInfo,
  RunMetricsHints,
  BatchMetricsHints,
} from '../types.js';
import type { Span, HealthStatus, OpenSearchLog, MetricsResult } from '../../../types/index.js';
import { fetchTraces, checkTracesHealth } from '../../services/tracesService.js';
import { fetchLogs } from '../../services/logsService.js';
import { computeMetrics, computeBatchMetrics } from '../../services/metricsService.js';

export interface ObservabilityIndexes {
  traces: string;
  logs: string;
  metrics: string;
}

class OpenSearchTracesOperations implements ITracesOperations {
  constructor(private readonly client: Client, private readonly index: string) {}

  async query(options: TracesQueryOptions) {
    const result = await fetchTraces(options as any, this.client, this.index);
    return {
      spans: (result.spans || []) as unknown as Span[],
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      hasMore: result.hasMore ?? false,
    };
  }

  async getByTraceId(traceId: string): Promise<Span[]> {
    return (await this.query({ traceId, size: 1000 })).spans;
  }

  async getByRunIds(runIds: string[]): Promise<Span[]> {
    if (!runIds.length) return [];
    return (await this.query({ runIds, size: 1000 })).spans;
  }
}

class OpenSearchLogsOperations implements ILogsOperations {
  constructor(private readonly client: Client, private readonly index: string) {}

  async query(options: LogsQueryOptions) {
    const result = await fetchLogs(options, this.client, this.index);
    return { logs: (result.logs || []) as unknown as OpenSearchLog[], total: result.total };
  }
}

class OpenSearchMetricsOperations implements IMetricsOperations {
  constructor(private readonly client: Client, private readonly index: string) {}

  forRun(runId: string, hints?: RunMetricsHints): Promise<MetricsResult> {
    return computeMetrics(runId, { client: this.client, indexPattern: this.index }, hints?.sessionId, hints?.traceId, hints?.agents);
  }

  forRuns(runIds: string[], hints?: BatchMetricsHints): Promise<MetricsResult[]> {
    return computeBatchMetrics(
      runIds,
      { client: this.client, indexPattern: this.index },
      hints?.sessionIdByRunId,
      hints?.traceIdByRunId,
      hints?.agentsByRunId
    );
  }
}

export class OpenSearchObservabilityModule implements IObservabilityModule {
  readonly traces: ITracesOperations;
  readonly logs: ILogsOperations;
  readonly metrics: IMetricsOperations;

  private readonly client: Client;
  private readonly indexes: ObservabilityIndexes;

  constructor(client: Client, indexes: ObservabilityIndexes) {
    this.client = client;
    this.indexes = indexes;
    this.traces = new OpenSearchTracesOperations(client, indexes.traces);
    this.logs = new OpenSearchLogsOperations(client, indexes.logs);
    this.metrics = new OpenSearchMetricsOperations(client, indexes.traces);
  }

  async health(): Promise<HealthStatus> {
    // checkTracesHealth's result already satisfies the wider HealthStatus union.
    return (await checkTracesHealth(this.client, this.indexes.traces)) as HealthStatus;
  }

  isConfigured(): boolean {
    return true;
  }

  describe(): ObservabilityBackendInfo {
    return { type: 'opensearch', target: this.indexes.traces };
  }
}
