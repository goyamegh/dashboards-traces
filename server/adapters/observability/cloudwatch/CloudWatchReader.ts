/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin wrapper over the CloudWatch Logs SDK — the only file that talks to AWS.
 *
 * Two read paths:
 *  - `filterEvents`: FilterLogEvents with a JSON metric-filter pattern. Synchronous,
 *    no indexing lag, no query quota — used for single-key lookups (traceId).
 *  - `insights`: Logs Insights StartQuery + GetQueryResults polling. Needed for
 *    OR'd multi-attribute correlation and for free-text browsing.
 *
 * Everything is injectable so the module can be tested against a fake.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
  type FilterLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { resolveSigv4Credentials } from '../../../services/opensearchClientFactory.js';

export interface CloudWatchReaderConfig {
  region: string;
  profile?: string;
  /** Default lookback for id-only queries (no time bounds). Default 14 days. */
  lookbackMs?: number;
  /** Insights poll interval / overall timeout. */
  insightsPollMs?: number;
  insightsTimeoutMs?: number;
}

export interface CloudWatchEvent {
  message: string;
  timestamp?: number;
  logStreamName?: string;
}

export interface InsightsRow {
  [field: string]: string;
}

export interface FilterEventsResult {
  events: CloudWatchEvent[];
  /** False when the scan stopped at `maxPages` before reaching the end of the window. */
  complete: boolean;
}

export interface ICloudWatchReader {
  /**
   * FilterLogEvents scans the window linearly (~1 MB / page), so callers bound
   * the scan with `maxPages` and fall back to an indexed Insights query when
   * the result is incomplete.
   */
  filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number; maxPages?: number }): Promise<FilterEventsResult>;
  insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number }): Promise<InsightsRow[]>;
  describeLogGroups(prefix: string): Promise<string[]>;
}

export const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export class CloudWatchReader implements ICloudWatchReader {
  private readonly client: CloudWatchLogsClient;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly config: CloudWatchReaderConfig, client?: CloudWatchLogsClient) {
    this.client =
      client ??
      new CloudWatchLogsClient({
        region: config.region,
        // Same refreshing provider the SigV4 OpenSearch path uses: re-reads a
        // rotated ~/.aws/credentials without a process restart.
        credentials: () => resolveSigv4Credentials(config.profile),
      });
    this.pollMs = config.insightsPollMs ?? 500;
    this.timeoutMs = config.insightsTimeoutMs ?? 30_000;
  }

  async filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number; maxPages?: number }): Promise<FilterEventsResult> {
    const out: CloudWatchEvent[] = [];
    const maxPages = opts.maxPages ?? 50;
    let pages = 0;
    let nextToken: string | undefined;
    do {
      pages++;
      const res: FilterLogEventsCommandOutput = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName: opts.logGroup,
          filterPattern: opts.pattern,
          startTime: Math.floor(opts.startMs),
          endTime: Math.ceil(opts.endMs),
          limit: Math.min(10_000, Math.max(1, opts.limit - out.length)),
          nextToken,
        })
      );
      for (const e of res.events || []) {
        if (e.message) out.push({ message: e.message, timestamp: e.timestamp, logStreamName: e.logStreamName });
      }
      nextToken = res.nextToken;
    } while (nextToken && out.length < opts.limit && pages < maxPages);
    return { events: out, complete: !nextToken || out.length >= opts.limit };
  }

  async insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number }): Promise<InsightsRow[]> {
    if (opts.logGroups.length === 0) return [];
    const started = await this.client.send(
      new StartQueryCommand({
        logGroupNames: opts.logGroups,
        queryString: opts.query,
        startTime: Math.floor(opts.startMs / 1000),
        endTime: Math.ceil(opts.endMs / 1000),
        limit: 10_000,
      })
    );
    const queryId = started.queryId;
    if (!queryId) throw new Error('CloudWatch Logs Insights did not return a queryId');

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const res = await this.client.send(new GetQueryResultsCommand({ queryId }));
      const status = res.status;
      if (status === 'Complete') {
        return (res.results || []).map((row) => {
          const obj: InsightsRow = {};
          for (const f of row) if (f.field && f.value !== undefined) obj[f.field] = f.value;
          return obj;
        });
      }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout' || status === 'Unknown') {
        throw new Error(`CloudWatch Logs Insights query ${status.toLowerCase()}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`CloudWatch Logs Insights query timed out after ${this.timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async describeLogGroups(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken, limit: 50 }));
      for (const g of res.logGroups || []) if (g.logGroupName) names.push(g.logGroupName);
      nextToken = res.nextToken;
    } while (nextToken && names.length < 500);
    return names;
  }

  get lookbackMs(): number {
    return this.config.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Classify an AWS SDK error for the HealthStatus contract.
 */
export function classifyCloudWatchError(error: unknown): { category: 'auth' | 'connection' | 'index_not_found' | 'unknown'; message: string; suggestion: string } {
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
  const name = err?.name || '';
  const message = err?.message || String(error);
  const status = err?.$metadata?.httpStatusCode;
  if (name === 'ResourceNotFoundException') {
    return { category: 'index_not_found', message, suggestion: 'Check the log group name and that Transaction Search is enabled in this account/region (it creates aws/spans).' };
  }
  if (
    name === 'CredentialsProviderError' || name === 'UnrecognizedClientException' || name === 'ExpiredTokenException' ||
    name === 'AccessDeniedException' || name === 'InvalidSignatureException' || status === 403 || status === 401
  ) {
    return { category: 'auth', message, suggestion: 'Refresh the AWS credentials for the configured profile (e.g. `ada credentials update …` / `aws sso login`) and confirm logs:FilterLogEvents, logs:StartQuery, logs:GetQueryResults, logs:DescribeLogGroups.' };
  }
  if (name === 'TimeoutError' || name === 'NetworkingError' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(message)) {
    return { category: 'connection', message, suggestion: 'Check network access to the CloudWatch Logs endpoint for the configured region.' };
  }
  return { category: 'unknown', message, suggestion: 'See server logs for details.' };
}
