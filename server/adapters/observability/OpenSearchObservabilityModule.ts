/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Observability Module
 *
 * Realizes the `IObservabilityModule` adapter interface against an OpenSearch
 * cluster, wrapping the existing `tracesService` / `logsService` read path.
 * This is the OpenSearch implementation of the pluggable observability
 * data-source — a sibling to the file-backed module (added in a later PR).
 *
 * Selection precedence (see docs/CONFIGURATION.md + AGENTS.md): when an
 * observability cluster is configured it is the ONLY trace source — a broken
 * cluster surfaces as an error, never a silent fallback to another backend.
 */

import { Client } from '@opensearch-project/opensearch';
import type {
  IObservabilityModule,
  ILogsOperations,
  ITracesOperations,
  IMetricsOperations,
  TracesQueryOptions,
  LogsQueryOptions,
} from '../types.js';
import type { Span, HealthStatus, OpenSearchLog } from '../../../types/index.js';
import { fetchTraces, checkTracesHealth } from '../../services/tracesService.js';
import { fetchLogs } from '../../services/logsService.js';
import { computeMetrics, computeBatchMetrics } from '../../services/metricsService.js';
import { computeAgentOverview } from '../../services/agentOverview.js';

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
  readonly supported = true;
  constructor(private readonly client: Client, private readonly index: string) {}

  async computeForRun(runId: string) {
    return computeMetrics(runId, { client: this.client, indexPattern: this.index });
  }

  async computeForRuns(runIds: string[]) {
    if (!runIds.length) return [];
    return computeBatchMetrics(runIds, { client: this.client, indexPattern: this.index });
  }

  async computeOverview(window: { startTime: number; endTime: number }) {
    // Pull spans for the window and aggregate per-service. Capped at OVERVIEW_MAX
    // spans — the overview is a summary, not an exhaustive scan (a future
    // optimization can push this into a native OpenSearch aggregation).
    const OVERVIEW_MAX = 10000;
    const result = await fetchTraces(
      { startTime: window.startTime, endTime: window.endTime, size: OVERVIEW_MAX } as any,
      this.client,
      this.index
    );
    const spans = (result.spans || []) as unknown as import('../../../types/index.js').Span[];
    const capped = (result.total ?? spans.length) > spans.length;
    return computeAgentOverview(spans, window, { capped });
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
}
