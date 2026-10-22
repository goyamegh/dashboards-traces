/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CloudWatch Observability Module
 *
 * IObservabilityModule backed by CloudWatch Logs:
 *   - traces  : Transaction Search's `aws/spans` log group (one JSON record per span)
 *   - logs    : per-service OTel log groups (default `/agent-health/{service.name}`)
 *   - metrics : derived from the run's spans with the shared metrics math
 *
 * Correlation semantics (strategies A/B/C/D) are identical to the OpenSearch
 * reader: the Logs Insights filter narrows the candidate set server-side and
 * `matchesQuery` applies the exact same predicate in memory, so both backends
 * return the same spans for the same request.
 */

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
import { DEFAULT_CLOUDWATCH_LOG_GROUPS } from '../../../types/index.js';
import { transformSpan, type OpenSearchSpanSource } from '../../services/tracesService.js';
import { buildChunkLookups, groupAndCompute } from '../../services/metricsService.js';
import { debug } from '../../../lib/debug.js';
import { computeUseUnion, matchesQuery, spanMs, toMs } from './traceQueryMatch.js';
import {
  CloudWatchReader,
  classifyCloudWatchError,
  DEFAULT_LOOKBACK_MS,
  type ICloudWatchReader,
} from './cloudwatch/CloudWatchReader.js';
import {
  cloudWatchLogToEntry,
  cloudWatchSpanToSource,
  logGroupTemplatePrefix,
  parseSpanRecord,
  resolveLogGroupTemplate,
} from './cloudwatch/recordMappers.js';

export interface CloudWatchLogGroups {
  traces: string;
  logs: string;
}

export interface CloudWatchModuleOptions {
  region: string;
  profile?: string;
  logGroups?: Partial<CloudWatchLogGroups>;
  lookbackMs?: number;
}

// ----------------------------------------------------------------------------
// Logs Insights query building
// ----------------------------------------------------------------------------

/** Quote a string literal for Logs Insights (double-quoted, backslash-escaped). */
export function q(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const field = (name: string): string => (name.includes('.') || name.includes('@') ? `\`${name}\`` : name);

const inList = (name: string, values: string[]): string => `${field(name)} in [${values.map(q).join(', ')}]`;

const SERVICE_FIELDS = ['resource.attributes.service.name', 'attributes.gen_ai.agent.name'];

const serviceClause = (name: string): string => `(${SERVICE_FIELDS.map((f) => `${field(f)} = ${q(name)}`).join(' or ')})`;

const msToNanos = (ms: number): string => `${Math.floor(ms)}000000`;

/**
 * Build the Logs Insights query for a traces request. Exported for tests.
 * Mirrors the DSL in server/services/tracesService.ts clause for clause.
 */
export function buildTracesInsightsQuery(options: TracesQueryOptions, useUnion: boolean): string {
  const { traceId, runIds, sessionId, startTime, endTime, serviceName, textSearch, agents } = options;
  const correlation: string[] = [];

  if (traceId) correlation.push(`traceId = ${q(traceId)}`);

  const validRunIds = (runIds || []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (validRunIds.length > 0) {
    correlation.push(
      `(${inList('attributes.agent_health.run.id', validRunIds)} or ${inList('attributes.gen_ai.conversation.id', validRunIds)})`
    );
  }

  for (const a of agents || []) {
    const strategyC = `(${serviceClause(a.serviceName)} and startTimeUnixNano >= ${msToNanos(a.startedAt)} and startTimeUnixNano <= ${msToNanos(a.endedAt)})`;
    correlation.push(a.sessionId ? `(${field('attributes.session.id')} = ${q(a.sessionId)} or ${strategyC})` : strategyC);
  }

  if (sessionId) correlation.push(`${field('attributes.session.id')} = ${q(sessionId)}`);

  const must: string[] = [];
  if (correlation.length > 0) {
    must.push(correlation.length === 1 ? correlation[0] : `(${correlation.join(useUnion ? ' or ' : ' and ')})`);
  }
  if (startTime) must.push(`startTimeUnixNano >= ${msToNanos(toMs(startTime))}`);
  if (endTime) must.push(`startTimeUnixNano <= ${msToNanos(toMs(endTime))}`);
  if (serviceName) must.push(serviceClause(serviceName));
  if (textSearch && textSearch.trim()) {
    // Case-insensitive substring over the whole record (name, ids, attribute values).
    const escaped = textSearch.trim().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    must.push(`@message like /(?i)${escaped}/`);
  }

  const parts = ['fields @message'];
  if (must.length > 0) parts.push(`filter ${must.join(' and ')}`);
  parts.push('sort startTimeUnixNano desc', 'limit 10000');
  return parts.join(' | ');
}

/** FilterLogEvents JSON pattern for an exact traceId match. */
export function traceIdFilterPattern(traceId: string): string {
  return `{ $.traceId = ${JSON.stringify(traceId)} }`;
}

/** Ids safe to use as quoted FilterLogEvents terms (no quotes / whitespace / control chars). */
const SAFE_TERM_RE = /^[^\s"\\\x00-\x1f]{1,256}$/;

/**
 * FilterLogEvents term pattern matching any event that contains one of the
 * ids (`?"a" ?"b"` = OR). Attribute keys with dots (`agent_health.run.id`)
 * cannot be addressed by JSON patterns, so we match the value anywhere in the
 * record and let `matchesQuery` enforce the exact attribute in memory.
 */
export function idTermsFilterPattern(ids: string[]): string | null {
  const terms = [...new Set(ids.filter((v) => typeof v === 'string' && SAFE_TERM_RE.test(v)))];
  if (terms.length === 0) return null;
  return terms.length === 1 ? JSON.stringify(terms[0]) : terms.map((t) => `?${JSON.stringify(t)}`).join(' ');
}

/** Every exact correlator on a request: traceId (A), runIds (B), sessionIds (D). */
export function exactCorrelatorIds(options: TracesQueryOptions): string[] {
  const ids: string[] = [];
  if (options.traceId) ids.push(options.traceId);
  for (const r of options.runIds || []) if (r) ids.push(r);
  if (options.sessionId) ids.push(options.sessionId);
  for (const a of options.agents || []) if (a.sessionId) ids.push(a.sessionId);
  return ids;
}

// ----------------------------------------------------------------------------
// Pagination (offset cursor, same scheme as the file backend)
// ----------------------------------------------------------------------------

function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const n = JSON.parse(decodeURIComponent(cursor))?.offset;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
const encodeOffset = (offset: number): string => encodeURIComponent(JSON.stringify({ offset }));

// ----------------------------------------------------------------------------
// Traces
// ----------------------------------------------------------------------------

class CloudWatchTracesOperations implements ITracesOperations {
  constructor(
    private readonly reader: ICloudWatchReader,
    private readonly logGroup: string,
    private readonly lookbackMs: number
  ) {}

  /**
   * Scan window: explicit bounds win; otherwise the union of the agents' run
   * windows (±5 min for clock skew — a run's spans cannot fall outside its own
   * wall-clock window); otherwise the configured lookback.
   */
  window(
    options: Pick<TracesQueryOptions, 'startTime' | 'endTime' | 'agents'>,
    /** Narrow to the agents' windows. Only valid when every correlator on the request belongs to the same run(s) those windows describe. */
    narrowToAgents = true
  ): { startMs: number; endMs: number } {
    const now = Date.now();
    if (options.startTime || options.endTime) {
      const endMs = options.endTime ? toMs(options.endTime) : now;
      const startMs = options.startTime ? toMs(options.startTime) : endMs - this.lookbackMs;
      return { startMs, endMs };
    }
    const windows = narrowToAgents ? (options.agents || []).filter((a) => Number.isFinite(a.startedAt) && Number.isFinite(a.endedAt)) : [];
    if (windows.length > 0) {
      const PAD = 5 * 60 * 1000;
      return {
        startMs: Math.min(...windows.map((a) => a.startedAt)) - PAD,
        endMs: Math.min(now, Math.max(...windows.map((a) => a.endedAt)) + PAD),
      };
    }
    return { startMs: now - this.lookbackMs, endMs: now };
  }

  /**
   * Fetch raw span sources for a request (before in-memory matching).
   *
   * Exact ids (traceId / runIds / sessionIds) go through FilterLogEvents —
   * synchronous and visible within seconds of ingestion, whereas Logs
   * Insights indexes `aws/spans` with a lag of up to several minutes (a fresh
   * run would otherwise show an empty Traces tab and zero metrics). Insights
   * is used only for what FilterLogEvents cannot express — service-name +
   * time-window (Strategy C) and free-text search — or when the bounded scan
   * did not cover the window. Both result sets are unioned; `matchesQuery`
   * then applies the exact predicate.
   */
  async fetchSources(
    options: TracesQueryOptions,
    useUnion: boolean,
    extraExactIds: string[] = [],
    /** Always run the window/Insights query even when exact ids already matched (batch keys that only have a window). */
    forceWindow = false
  ): Promise<OpenSearchSpanSource[]> {
    const { agents, textSearch } = options;
    // The agents' windows bound the Insights (Strategy C) query by construction.
    // They may bound the exact-id scan too ONLY in the single-run shape (the
    // run-report Traces tab: one run's traceId/runId plus that run's window);
    // a batch chunk mixes keys whose runs happened at different times, so its
    // id scan must cover the full lookback or an older id-only key sees nothing.
    const singleRunShape = !forceWindow && extraExactIds.length === 0 && (options.runIds?.filter(Boolean).length ?? 0) <= 1;
    const { startMs, endMs } = this.window(options);
    const exactScan = singleRunShape ? { startMs, endMs } : this.window(options, false);
    const messages: string[] = [];

    const exactPattern = idTermsFilterPattern([...exactCorrelatorIds(options), ...extraExactIds]);
    let exactComplete = false;
    if (exactPattern) {
      const res = await this.reader.filterEvents({ logGroup: this.logGroup, pattern: exactPattern, startMs: exactScan.startMs, endMs: exactScan.endMs, limit: 10_000 });
      messages.push(...res.events.map((e) => e.message));
      exactComplete = res.complete;
      debug('CloudWatchTraces', `FilterLogEvents(${exactPattern}) → ${res.events.length} records, complete=${res.complete}`);
    }

    const needsWindow = !!(agents && agents.length > 0) || !!(textSearch && textSearch.trim());
    const noExact = !exactPattern;
    // With union semantics a window clause can only ADD spans; skip the slower
    // Insights round-trip when the exact ids already found this run's spans.
    const windowStillNeeded = needsWindow && (forceWindow || !useUnion || messages.length === 0);
    if (noExact || windowStillNeeded || (exactPattern && !exactComplete)) {
      const rows = await this.reader.insights({
        logGroups: [this.logGroup],
        query: buildTracesInsightsQuery(options, useUnion),
        startMs,
        endMs,
      });
      messages.push(...rows.map((r) => r['@message']).filter((m): m is string => typeof m === 'string'));
      debug('CloudWatchTraces', `Insights → ${rows.length} records`);
    }

    const sources: OpenSearchSpanSource[] = [];
    for (const m of messages) {
      const rec = parseSpanRecord(m);
      if (rec) sources.push(cloudWatchSpanToSource(rec));
    }
    return sources;
  }

  async query(options: TracesQueryOptions) {
    const { traceId, runIds, sessionId, startTime, endTime, size = 100, cursor, agents } = options;
    const hasTimeRange = startTime !== undefined || endTime !== undefined;
    const hasIdFilter = !!(traceId || (runIds && runIds.length > 0) || sessionId || (agents && agents.length > 0));
    if (!hasIdFilter && !hasTimeRange) {
      throw new Error('Either traceId, runIds, sessionId, agents, or time range is required');
    }

    const useUnion = computeUseUnion(options);
    const sources = await this.fetchSources(options, useUnion);
    const spans = sources.map((s) => transformSpan(s) as unknown as Span);

    // Exact predicate parity with the OpenSearch reader; dedupe on spanId in
    // case a span was delivered twice (CloudWatch at-least-once semantics).
    const seen = new Set<string>();
    const matched = spans
      .filter((s) => matchesQuery(s, options, useUnion))
      .filter((s) => (seen.has(s.spanId) ? false : (seen.add(s.spanId), true)))
      .sort((x, y) => spanMs(y) - spanMs(x)); // newest first

    const offset = decodeOffset(cursor);
    const page = matched.slice(offset, offset + size);
    const hasMore = matched.length > offset + size;
    return { spans: page, total: matched.length, nextCursor: hasMore ? encodeOffset(offset + size) : null, hasMore };
  }

  async getByTraceId(traceId: string): Promise<Span[]> {
    return (await this.query({ traceId, size: 10_000 })).spans;
  }

  async getByRunIds(runIds: string[]): Promise<Span[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (!valid.length) return [];
    return (await this.query({ runIds: valid, size: 10_000 })).spans;
  }
}

// ----------------------------------------------------------------------------
// Logs
// ----------------------------------------------------------------------------

class CloudWatchLogsOperations implements ILogsOperations {
  constructor(
    private readonly reader: ICloudWatchReader,
    private readonly template: string,
    private readonly lookbackMs: number
  ) {}

  /** Log groups to search: the template resolved for the service, else every group under the template prefix. */
  async resolveGroups(serviceName?: string): Promise<string[]> {
    const resolved = resolveLogGroupTemplate(this.template, serviceName);
    if (resolved) return [resolved];
    const prefix = logGroupTemplatePrefix(this.template);
    return prefix ? this.reader.describeLogGroups(prefix) : [];
  }

  async query(options: LogsQueryOptions): Promise<{ logs: OpenSearchLog[]; total: number }> {
    const { traceId, runId, serviceName, query, startTime, endTime, size = 100 } = options;
    const groups = await this.resolveGroups(serviceName);
    if (groups.length === 0) return { logs: [], total: 0 };

    const now = Date.now();
    const endMs = endTime ?? now;
    // Id lookups search the full lookback (parity with the OpenSearch reader's
    // "regardless of age" for runId); browsing defaults to the last hour.
    const startMs = startTime ?? (traceId || runId ? endMs - this.lookbackMs : endMs - 60 * 60 * 1000);

    let pattern = '';
    if (traceId) pattern = traceIdFilterPattern(traceId);
    else if (runId) pattern = JSON.stringify(runId); // quoted term match anywhere in the event
    else if (query) pattern = JSON.stringify(query);

    const perGroup = await Promise.all(
      groups.map(async (g) => {
        try {
          const { events } = await this.reader.filterEvents({ logGroup: g, pattern, startMs, endMs, limit: size });
          return events.map((e) => cloudWatchLogToEntry(e.message, e.timestamp, g));
        } catch (err) {
          const c = classifyCloudWatchError(err);
          if (c.category === 'index_not_found') return []; // group for this service does not exist yet
          throw err;
        }
      })
    );

    let logs = perGroup.flat();
    if (query && (traceId || runId)) {
      const needle = query.toLowerCase();
      logs = logs.filter((l) => l.message.toLowerCase().includes(needle));
    }
    logs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const page = logs.slice(0, size);
    return { logs: page as unknown as OpenSearchLog[], total: logs.length };
  }
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------

class CloudWatchMetricsOperations implements IMetricsOperations {
  constructor(private readonly traces: CloudWatchTracesOperations) {}

  async forRun(runId: string, hints?: RunMetricsHints): Promise<MetricsResult> {
    const batch: BatchMetricsHints = {
      sessionIdByRunId: hints?.sessionId ? { [runId]: hints.sessionId } : undefined,
      traceIdByRunId: hints?.traceId ? { [runId]: hints.traceId } : undefined,
      agentsByRunId: hints?.agents?.length ? { [runId]: hints.agents } : undefined,
    };
    return (await this.forRuns([runId], batch))[0];
  }

  /**
   * One traces fetch per chunk with every correlator unioned (run ids via
   * FilterLogEvents, Strategy-C windows via Insights when needed), then the
   * SAME attribution + math as the OpenSearch backend (`buildChunkLookups` /
   * `groupAndCompute`), so both report identical numbers and `correlatedBy`.
   */
  async forRuns(runIds: string[], hints?: BatchMetricsHints): Promise<MetricsResult[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (valid.length === 0) return [];
    const CHUNK = 50;
    const results: MetricsResult[] = [];
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      const lookups = buildChunkLookups(chunk, hints?.sessionIdByRunId, hints?.traceIdByRunId, hints?.agentsByRunId);
      let sources: OpenSearchSpanSource[] = [];
      try {
        const traceIds = [...lookups.traceIdToRunId.keys()];
        const query: TracesQueryOptions = {
          runIds: lookups.runIdCorrelators,
          agents: lookups.agentHints.length ? lookups.agentHints : undefined,
          // Strategy A ids ride along as plain correlator terms (FilterLogEvents
          // matches them anywhere in the record); the attribution step maps
          // each span back to its key by traceId.
          ...(traceIds.length === 1 ? { traceId: traceIds[0] } : {}),
        };
        const extraIds = [...lookups.sessionIdToRunId.keys(), ...(traceIds.length > 1 ? traceIds : [])];
        // A key with only a window hint (surrogate) can only be served by the
        // window query, so it must run even when other keys' ids already hit.
        const hasSurrogateKey = lookups.runIdCorrelators.length < chunk.length;
        sources = await this.traces.fetchSources(query, true, extraIds, hasSurrogateKey);
      } catch (e: any) {
        console.warn(`[CloudWatchMetrics] span query failed for ${chunk.length} run id(s): ${e?.message ?? e}`);
      }
      const seen = new Set<string>();
      const unique = sources.filter((src) => (src.spanId && seen.has(src.spanId) ? false : (src.spanId && seen.add(src.spanId), true)));
      unique.sort((x, y) => Date.parse(x.startTime || '') - Date.parse(y.startTime || ''));
      results.push(...groupAndCompute(chunk, unique, lookups, false));
    }
    return results;
  }
}

// ----------------------------------------------------------------------------
// Module
// ----------------------------------------------------------------------------

export class CloudWatchObservabilityModule implements IObservabilityModule {
  readonly traces: ITracesOperations;
  readonly logs: ILogsOperations;
  readonly metrics: IMetricsOperations;
  readonly logGroups: CloudWatchLogGroups;
  private readonly reader: ICloudWatchReader;

  constructor(private readonly options: CloudWatchModuleOptions, reader?: ICloudWatchReader) {
    this.logGroups = {
      traces: options.logGroups?.traces || DEFAULT_CLOUDWATCH_LOG_GROUPS.traces,
      logs: options.logGroups?.logs || DEFAULT_CLOUDWATCH_LOG_GROUPS.logs,
    };
    const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.reader = reader ?? new CloudWatchReader({ region: options.region, profile: options.profile, lookbackMs });
    const traces = new CloudWatchTracesOperations(this.reader, this.logGroups.traces, lookbackMs);
    this.traces = traces;
    this.logs = new CloudWatchLogsOperations(this.reader, this.logGroups.logs, lookbackMs);
    this.metrics = new CloudWatchMetricsOperations(traces);
  }

  async health(): Promise<HealthStatus> {
    try {
      const groups = await this.reader.describeLogGroups(this.logGroups.traces);
      if (groups.includes(this.logGroups.traces)) {
        return { status: 'ok', index: this.logGroups.traces };
      }
      return {
        status: 'error',
        index: this.logGroups.traces,
        error: `Log group '${this.logGroups.traces}' not found in ${this.options.region}`,
        errorCategory: 'index_not_found',
        suggestion: 'Enable CloudWatch Transaction Search in this account/region (it creates aws/spans), or set observability.logGroups.traces.',
      };
    } catch (error) {
      const c = classifyCloudWatchError(error);
      return { status: 'error', index: this.logGroups.traces, error: c.message, errorCategory: c.category, suggestion: c.suggestion };
    }
  }

  /** Log groups currently present under the logs template prefix (Test Connection detail). */
  async listLogGroups(): Promise<string[]> {
    return this.reader.describeLogGroups(logGroupTemplatePrefix(this.logGroups.logs));
  }

  isConfigured(): boolean {
    return Boolean(this.options.region);
  }

  describe(): ObservabilityBackendInfo {
    return { type: 'cloudwatch', target: this.logGroups.traces, region: this.options.region };
  }
}
