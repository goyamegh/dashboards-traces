/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin wrapper over the CloudWatch Logs SDK — the only file that talks to AWS.
 *
 * Two read paths:
 *  - `filterEvents`: FilterLogEvents with a metric-filter pattern. Synchronous,
 *    no indexing lag, no query quota — used for exact-id lookups.
 *  - `insights`: Logs Insights StartQuery + GetQueryResults polling. Needed for
 *    OR'd multi-attribute correlation and for free-text browsing. A query that
 *    outlives the local deadline is cancelled server-side with StopQuery.
 *
 * Bounds (stated in docs/CONFIGURATION.md):
 *  - at most `maxConcurrent` (default 4) AWS calls in flight per reader;
 *  - a FilterLogEvents scan stops after `maxPages` (default 50 × ~1 MB) and
 *    reports `complete: false` — callers fall back to Insights or surface
 *    "partial" to the user; reaching the row limit with a `nextToken` is also
 *    partial;
 *  - DescribeLogGroups discovery returns at most `maxLogGroups` (default 20)
 *    groups and reports `truncated` when more exist.
 *
 * Everything is injectable so the module can be tested against a fake.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
  DescribeLogGroupsCommand,
  type FilterLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { createRefreshingCredentialProvider } from '../../../../lib/aws/refreshingCredentialProvider.js';

export interface CloudWatchReaderConfig {
  region: string;
  profile?: string;
  /** Insights poll interval / overall timeout. */
  insightsPollMs?: number;
  insightsTimeoutMs?: number;
  /** Max AWS calls in flight per reader (default 4). */
  maxConcurrent?: number;
  /** Max log groups returned by discovery (default 20). */
  maxLogGroups?: number;
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
  /**
   * False when the scan did not cover the whole window: it stopped at
   * `maxPages`, or the row `limit` was reached while CloudWatch still had a
   * `nextToken`. Either way the caller must not present the result as whole.
   */
  complete: boolean;
}

export interface InsightsResult {
  rows: InsightsRow[];
  /** True when the query returned exactly its row limit — more rows may exist. */
  truncated: boolean;
}

export interface LogGroupsResult {
  names: string[];
  /** True when discovery stopped at `maxLogGroups` with more groups available. */
  truncated: boolean;
}

export interface ICloudWatchReader {
  filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number; maxPages?: number }): Promise<FilterEventsResult>;
  insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number; limit?: number }): Promise<InsightsResult>;
  describeLogGroups(prefix: string): Promise<LogGroupsResult>;
}

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_LOG_GROUPS = 20;
export const DEFAULT_MAX_PAGES = 50;
export const INSIGHTS_ROW_LIMIT = 10_000;

/** Minimal promise semaphore — bounds in-flight AWS calls per reader. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class CloudWatchReader implements ICloudWatchReader {
  private readonly client: CloudWatchLogsClient;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly maxLogGroups: number;
  private readonly gate: Semaphore;

  constructor(private readonly config: CloudWatchReaderConfig, client?: CloudWatchLogsClient) {
    this.client =
      client ??
      new CloudWatchLogsClient({
        region: config.region,
        // The repo-wide refreshing provider (60 s TTL, coalesced): a rotated
        // ~/.aws/credentials is picked up without a process restart.
        credentials: createRefreshingCredentialProvider({ profile: config.profile }),
      });
    this.pollMs = config.insightsPollMs ?? 500;
    this.timeoutMs = config.insightsTimeoutMs ?? 30_000;
    this.maxLogGroups = config.maxLogGroups ?? DEFAULT_MAX_LOG_GROUPS;
    this.gate = new Semaphore(config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  async filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number; maxPages?: number }): Promise<FilterEventsResult> {
    const out: CloudWatchEvent[] = [];
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    let pages = 0;
    let nextToken: string | undefined;
    do {
      pages++;
      const res: FilterLogEventsCommandOutput = await this.gate.run(() =>
        this.client.send(
          new FilterLogEventsCommand({
            logGroupName: opts.logGroup,
            filterPattern: opts.pattern,
            startTime: Math.floor(opts.startMs),
            endTime: Math.ceil(opts.endMs),
            limit: Math.min(10_000, Math.max(1, opts.limit - out.length)),
            nextToken,
          })
        )
      );
      for (const e of res.events || []) {
        if (e.message) out.push({ message: e.message, timestamp: e.timestamp, logStreamName: e.logStreamName });
      }
      nextToken = res.nextToken;
    } while (nextToken && out.length < opts.limit && pages < maxPages);
    // Complete only when CloudWatch itself said there is nothing more: a
    // remaining nextToken means unscanned data, whether we stopped for the
    // page budget or because the caller's row limit filled up.
    return { events: out, complete: !nextToken };
  }

  async insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number; limit?: number }): Promise<InsightsResult> {
    if (opts.logGroups.length === 0) return { rows: [], truncated: false };
    const limit = opts.limit ?? INSIGHTS_ROW_LIMIT;
    return this.gate.run(async () => {
      const started = await this.client.send(
        new StartQueryCommand({
          logGroupNames: opts.logGroups,
          queryString: opts.query,
          startTime: Math.floor(opts.startMs / 1000),
          endTime: Math.ceil(opts.endMs / 1000),
          limit,
        })
      );
      const queryId = started.queryId;
      if (!queryId) throw new Error('CloudWatch Logs Insights did not return a queryId');

      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        const res = await this.client.send(new GetQueryResultsCommand({ queryId }));
        const status = res.status;
        if (status === 'Complete') {
          const rows = (res.results || []).map((row) => {
            const obj: InsightsRow = {};
            for (const f of row) if (f.field && f.value !== undefined) obj[f.field] = f.value;
            return obj;
          });
          return { rows, truncated: rows.length >= limit };
        }
        if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout' || status === 'Unknown') {
          throw new Error(`CloudWatch Logs Insights query ${status.toLowerCase()}`);
        }
        if (Date.now() > deadline) {
          // Cancel server-side so an abandoned query does not keep consuming
          // the account's concurrent-query quota.
          await this.client.send(new StopQueryCommand({ queryId })).catch(() => {});
          throw new Error(`CloudWatch Logs Insights query timed out after ${this.timeoutMs}ms (stopped)`);
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    });
  }

  async describeLogGroups(prefix: string): Promise<LogGroupsResult> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.gate.run(() =>
        this.client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken, limit: Math.min(50, this.maxLogGroups - names.length + 1) }))
      );
      for (const g of res.logGroups || []) if (g.logGroupName) names.push(g.logGroupName);
      nextToken = res.nextToken;
    } while (nextToken && names.length <= this.maxLogGroups);
    const truncated = names.length > this.maxLogGroups || !!nextToken;
    return { names: names.slice(0, this.maxLogGroups), truncated };
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
    return { category: 'auth', message, suggestion: 'Refresh the AWS credentials for the configured profile (e.g. `ada credentials update …` / `aws sso login`) and confirm logs:FilterLogEvents, logs:StartQuery, logs:GetQueryResults, logs:StopQuery, logs:DescribeLogGroups.' };
  }
  if (name === 'TimeoutError' || name === 'NetworkingError' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(message)) {
    return { category: 'connection', message, suggestion: 'Check network access to the CloudWatch Logs endpoint for the configured region.' };
  }
  return { category: 'unknown', message, suggestion: 'See server logs for details.' };
}
