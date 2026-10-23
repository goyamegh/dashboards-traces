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
import { buildChunkLookups, groupAndCompute, failedMetricsResult } from '../../services/metricsService.js';
import { debug } from '../../../lib/debug.js';
import { computeUseUnion, matchesQuery, spanMs, toMs } from './traceQueryMatch.js';
import {
  CloudWatchReader,
  classifyCloudWatchError,
  INSIGHTS_ROW_LIMIT,
  type ICloudWatchReader,
} from './cloudwatch/CloudWatchReader.js';
import {
  cloudWatchLogToEntry,
  cloudWatchSpanToSource,
  logGroupTemplatePrefix,
  parseSpanRecord,
  resolveLogGroupTemplate,
} from './cloudwatch/recordMappers.js';

/** Id lookups in application log groups scan at most this far back by default (they are large). */
export const DEFAULT_LOGS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface CloudWatchLogGroups {
  traces: string;
  logs: string;
}

export interface CloudWatchModuleOptions {
  region: string;
  profile?: string;
  logGroups?: Partial<CloudWatchLogGroups>;
  /** Scan window for id-only requests that carry no run window (default 7 days). */
  lookbackMs?: number;
  /** Scan window for id lookups in application log groups (default 24 hours). */
  logsLookbackMs?: number;
  /** Hard cap on any scan window, explicit or derived (default 30 days). */
  maxWindowMs?: number;
}

/**
 * Bounds. A request never scans more than `maxWindowMs`; an id-only request
 * with no run window scans the last `lookbackMs`; a request that carries the
 * run's wall-clock window (the run-report shape) scans just that window ±5 min.
 */
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const WINDOW_PAD_MS = 5 * 60 * 1000;
/** How long an id-scan snapshot is reused for offset paging before re-scanning. */
export const SNAPSHOT_TTL_MS = 60 * 1000;
/**
 * The freshness scan: FilterLogEvents over the newest `FRESH_SCAN_MS` of the
 * window (Logs Insights indexes `aws/spans` with a lag of minutes; anything
 * older is served by the indexed query), reading at most `FRESH_SCAN_PAGES`
 * pages (~1 MB each) so a busy account's group cannot turn it into a linear
 * scan. FilterLogEvents reads oldest-first, which is why the bound is on time
 * (the newest slice) and not only on pages (which would read the oldest slice).
 */
export const FRESH_SCAN_MS = 20 * 60 * 1000;
export const FRESH_SCAN_PAGES = 10;

/** Result of a raw fetch: the candidate records plus whether every path covered its window. */
export interface FetchedSources {
  sources: OpenSearchSpanSource[];
  truncated: boolean;
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

/** Traces request plus the batch-metrics case of several trace ids in one query. */
export type InsightsTracesOptions = TracesQueryOptions & { traceIds?: string[] };

/**
 * Build the Logs Insights query for a traces request. Exported for tests.
 * Mirrors the DSL in server/services/tracesService.ts clause for clause.
 */
export function buildTracesInsightsQuery(options: InsightsTracesOptions, useUnion: boolean): string {
  const { traceId, traceIds, runIds, sessionId, startTime, endTime, serviceName, textSearch, agents } = options;
  const correlation: string[] = [];

  const allTraceIds = [...new Set([traceId, ...(traceIds || [])].filter((t): t is string => typeof t === 'string' && t.length > 0))];
  if (allTraceIds.length === 1) correlation.push(`traceId = ${q(allTraceIds[0])}`);
  else if (allTraceIds.length > 1) correlation.push(inList('traceId', allTraceIds));

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
  private readonly snapshots = new Map<string, { at: number; spans: Span[]; truncated: boolean }>();

  constructor(
    private readonly reader: ICloudWatchReader,
    private readonly logGroup: string,
    private readonly lookbackMs: number,
    private readonly maxWindowMs: number
  ) {}

  /**
   * Scan window: explicit bounds win; otherwise the union of the agents' run
   * windows ±5 min (a run's spans cannot fall outside its own wall-clock
   * window); otherwise the configured lookback. Always clamped to `maxWindowMs`
   * (the newest part of the range is kept).
   */
  window(
    options: Pick<TracesQueryOptions, 'startTime' | 'endTime' | 'agents'>,
    /** Narrow to the agents' windows. Only valid when every correlator on the request belongs to the run(s) those windows describe. */
    narrowToAgents = true
  ): { startMs: number; endMs: number; clamped: boolean } {
    const now = Date.now();
    let startMs: number;
    let endMs: number;
    if (options.startTime || options.endTime) {
      endMs = options.endTime ? toMs(options.endTime) : now;
      startMs = options.startTime ? toMs(options.startTime) : endMs - this.lookbackMs;
    } else {
      const windows = narrowToAgents ? (options.agents || []).filter((a) => Number.isFinite(a.startedAt) && Number.isFinite(a.endedAt)) : [];
      if (windows.length > 0) {
        startMs = Math.min(...windows.map((a) => a.startedAt)) - WINDOW_PAD_MS;
        endMs = Math.min(now, Math.max(...windows.map((a) => a.endedAt)) + WINDOW_PAD_MS);
      } else {
        endMs = now;
        startMs = now - this.lookbackMs;
      }
    }
    // Over-cap ranges are clamped to the newest `maxWindowMs` and reported as
    // clamped so the result is marked partial (never silently narrowed).
    const clamped = endMs - startMs > this.maxWindowMs;
    if (clamped) startMs = endMs - this.maxWindowMs;
    return { startMs, endMs, clamped };
  }

  /** Exact-id path: FilterLogEvents term scan (bounded to `maxPages` when given). */
  async fetchExact(ids: string[], scan: { startMs: number; endMs: number }, maxPages?: number): Promise<FetchedSources> {
    const pattern = idTermsFilterPattern(ids);
    if (!pattern || scan.endMs <= scan.startMs) return { sources: [], truncated: false };
    const res = await this.reader.filterEvents({ logGroup: this.logGroup, pattern, startMs: scan.startMs, endMs: scan.endMs, limit: INSIGHTS_ROW_LIMIT, maxPages });
    debug('CloudWatchTraces', `FilterLogEvents(${pattern}) → ${res.events.length} records, complete=${res.complete}`);
    return { sources: parseAll(res.events.map((e) => e.message)), truncated: !res.complete };
  }

  /** The newest `FRESH_SCAN_MS` of a scan window — what FilterLogEvents covers; Insights covers the rest. */
  freshSlice(scan: { startMs: number; endMs: number }): { startMs: number; endMs: number } {
    return { startMs: Math.max(scan.startMs, scan.endMs - FRESH_SCAN_MS), endMs: scan.endMs };
  }

  /**
   * Exact ids over the fresh slice (FilterLogEvents, bounded) IN PARALLEL with
   * the indexed Logs Insights query over the whole window; the union is
   * returned. The exact predicate (`matchesQuery`) is applied by the caller,
   * so fetching the window up front cannot misattribute — and an id hit made
   * only of Agent Health's eval/judge spans can no longer hide the agent's
   * Strategy-C window spans, because the window is always read. Partial only
   * when Insights hit its row limit or the window was clamped: the bounded
   * scan stopping early is covered by Insights (minus its ingestion lag).
   */
  async fetchBoth(exactIds: string[], insightsOptions: InsightsTracesOptions, useUnion: boolean, scan: { startMs: number; endMs: number; clamped: boolean }): Promise<FetchedSources> {
    const [exact, win] = await Promise.all([
      this.fetchExact(exactIds, this.freshSlice(scan), FRESH_SCAN_PAGES),
      this.fetchWindow(insightsOptions, useUnion, scan),
    ]);
    const seen = new Set<string>();
    const sources = [...exact.sources, ...win.sources].filter((src) => (src.spanId && seen.has(src.spanId) ? false : (src.spanId && seen.add(src.spanId), true)));
    return { sources, truncated: win.truncated || scan.clamped };
  }

  /** Window / free-text path: Logs Insights. */
  async fetchWindow(options: InsightsTracesOptions, useUnion: boolean, scan: { startMs: number; endMs: number }): Promise<FetchedSources> {
    const res = await this.reader.insights({ logGroups: [this.logGroup], query: buildTracesInsightsQuery(options, useUnion), startMs: scan.startMs, endMs: scan.endMs });
    debug('CloudWatchTraces', `Insights → ${res.rows.length} records, truncated=${res.truncated}`);
    return { sources: parseAll(res.rows.map((r) => r['@message']).filter((m): m is string => typeof m === 'string')), truncated: res.truncated };
  }

  /**
   * Fetch raw span sources for ONE request (the traces route): the fresh
   * FilterLogEvents slice for the exact ids (traceId / runIds / sessionIds —
   * visible within seconds of ingestion) in parallel with the Insights query
   * for the full request (indexed; the only path for the agents window and
   * free text) — see `fetchBoth`. On a small account both answer instantly; on
   * a production account with a multi-GB `aws/spans` this keeps a trace lookup
   * at Insights latency (seconds) instead of a linear scan (tens of seconds).
   */
  async fetchSources(options: TracesQueryOptions, useUnion: boolean): Promise<FetchedSources> {
    return this.fetchBoth(exactCorrelatorIds(options), options, useUnion, this.window(options));
  }

  async query(options: TracesQueryOptions) {
    const { traceId, runIds, sessionId, startTime, endTime, size = 100, cursor, agents } = options;
    const hasTimeRange = startTime !== undefined || endTime !== undefined;
    const hasIdFilter = !!(traceId || (runIds && runIds.length > 0) || sessionId || (agents && agents.length > 0));
    if (!hasIdFilter && !hasTimeRange) {
      throw new Error('Either traceId, runIds, sessionId, agents, or time range is required');
    }

    // Offset paging reuses the snapshot the first page was cut from (for a
    // short TTL) instead of re-scanning the window for every page.
    const { cursor: _c, size: _s, ...rest } = options;
    const key = JSON.stringify(rest);
    const cached = cursor ? this.snapshots.get(key) : undefined;
    let matched: Span[];
    let truncated: boolean;
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
      matched = cached.spans;
      truncated = cached.truncated;
    } else {
      const useUnion = computeUseUnion(options);
      const fetched = await this.fetchSources(options, useUnion);
      const spans = fetched.sources.map((s) => transformSpan(s) as unknown as Span);
      // Exact predicate parity with the OpenSearch reader; dedupe on spanId in
      // case a span was delivered twice (CloudWatch at-least-once semantics).
      const seen = new Set<string>();
      matched = spans
        .filter((s) => matchesQuery(s, options, useUnion))
        .filter((s) => (seen.has(s.spanId) ? false : (seen.add(s.spanId), true)))
        .sort((x, y) => spanMs(y) - spanMs(x)); // newest first
      truncated = fetched.truncated;
      this.snapshots.set(key, { at: Date.now(), spans: matched, truncated });
      if (this.snapshots.size > 50) this.snapshots.delete(this.snapshots.keys().next().value!);
    }

    const offset = decodeOffset(cursor);
    const page = matched.slice(offset, offset + size);
    const hasMore = matched.length > offset + size;
    return { spans: page, total: matched.length, nextCursor: hasMore ? encodeOffset(offset + size) : null, hasMore, truncated };
  }

  async getByTraceId(traceId: string): Promise<Span[]> {
    return (await this.query({ traceId, size: INSIGHTS_ROW_LIMIT })).spans;
  }

  async getByRunIds(runIds: string[]): Promise<Span[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (!valid.length) return [];
    return (await this.query({ runIds: valid, size: INSIGHTS_ROW_LIMIT })).spans;
  }
}

function parseAll(messages: string[]): OpenSearchSpanSource[] {
  const sources: OpenSearchSpanSource[] = [];
  for (const m of messages) {
    const rec = parseSpanRecord(m);
    if (rec) sources.push(cloudWatchSpanToSource(rec));
  }
  return sources;
}

// ----------------------------------------------------------------------------
// Logs
// ----------------------------------------------------------------------------

class CloudWatchLogsOperations implements ILogsOperations {
  constructor(
    private readonly reader: ICloudWatchReader,
    private readonly template: string,
    private readonly lookbackMs: number,
    private readonly maxWindowMs: number,
    /** Used to derive a trace's time window so a trace-id log lookup scans minutes, not the whole lookback. */
    private readonly traces?: ITracesOperations
  ) {}

  /** [first span start − 5 min, last span end + 5 min] for a trace, or null when the trace is not in this source. */
  private async windowForTrace(traceId: string): Promise<{ startMs: number; endMs: number } | null> {
    if (!this.traces) return null;
    try {
      const spans = await this.traces.getByTraceId(traceId);
      if (spans.length === 0) return null;
      const starts = spans.map((s) => Date.parse(s.startTime)).filter(Number.isFinite);
      const ends = spans.map((s) => Date.parse(s.endTime || s.startTime)).filter(Number.isFinite);
      if (!starts.length) return null;
      return { startMs: Math.min(...starts) - WINDOW_PAD_MS, endMs: Math.max(...ends) + WINDOW_PAD_MS };
    } catch {
      return null;
    }
  }

  /** Log groups to search: the template resolved for the service, else the groups under the template prefix (bounded by the reader). */
  async resolveGroups(serviceName?: string): Promise<{ groups: string[]; truncated: boolean }> {
    const resolved = resolveLogGroupTemplate(this.template, serviceName);
    if (resolved) return { groups: [resolved], truncated: false };
    const prefix = logGroupTemplatePrefix(this.template);
    if (!prefix) return { groups: [], truncated: false };
    const res = await this.reader.describeLogGroups(prefix);
    return { groups: res.names, truncated: res.truncated };
  }

  async query(options: LogsQueryOptions): Promise<{ logs: OpenSearchLog[]; total: number; truncated?: boolean }> {
    const { traceId, runId, serviceName, query, startTime, endTime, size = 100 } = options;
    const { groups, truncated: groupsTruncated } = await this.resolveGroups(serviceName);
    if (groups.length === 0) return { logs: [], total: 0, truncated: groupsTruncated };

    const now = Date.now();
    let endMs = endTime ?? now;
    // Id lookups search the lookback; browsing defaults to the last hour. A
    // trace-id lookup without bounds first asks the trace for its own window
    // (application log groups are large; a full-lookback scan takes a minute).
    let startMs = startTime ?? (traceId || runId ? endMs - this.lookbackMs : endMs - 60 * 60 * 1000);
    if (traceId && startTime === undefined && endTime === undefined) {
      const w = await this.windowForTrace(traceId);
      if (w) { startMs = w.startMs; endMs = Math.min(now, w.endMs); }
    }
    const clamped = endMs - startMs > this.maxWindowMs;
    if (clamped) startMs = endMs - this.maxWindowMs;

    // Quoted-term patterns match the id wherever it sits in the record (OTel
    // `traceId` or application-logger `trace_id`); exactness is enforced below.
    let pattern = '';
    if (traceId) pattern = idTermsFilterPattern([traceId]) ?? '';
    else if (runId) pattern = JSON.stringify(runId);
    else if (query) pattern = JSON.stringify(query);

    // FilterLogEvents returns oldest-first; the newest `size` matches are what
    // the caller wants, so a group is scanned past `size` (bounded by the reader's
    // page budget) and trimmed after sorting rather than cut off at the oldest.
    const perGroupLimit = Math.min(INSIGHTS_ROW_LIMIT, size * 10);
    let anyTruncated = groupsTruncated || clamped;
    const perGroup = await Promise.all(
      groups.map(async (g) => {
        try {
          const res = await this.reader.filterEvents({ logGroup: g, pattern, startMs, endMs, limit: perGroupLimit });
          if (!res.complete) anyTruncated = true;
          return res.events.map((e) => cloudWatchLogToEntry(e.message, e.timestamp, g));
        } catch (err) {
          const c = classifyCloudWatchError(err);
          if (c.category === 'index_not_found') return []; // group for this service does not exist yet
          throw err;
        }
      })
    );

    let logs = perGroup.flat();
    if (traceId) logs = logs.filter((l) => !l.traceId || l.traceId === traceId); // plain-text lines (no id field) are kept: the term matched
    if (query && (traceId || runId)) {
      const needle = query.toLowerCase();
      logs = logs.filter((l) => l.message.toLowerCase().includes(needle));
    }
    logs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const page = logs.slice(0, size);
    return { logs: page as unknown as OpenSearchLog[], total: logs.length, truncated: anyTruncated || logs.length > size };
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
   * Per 50-key chunk: ONE pass of `fetchBoth` — the exact ids (run ids,
   * session ids, trace ids) over the fresh slice plus one Insights query
   * carrying the same ids and every window hint, in parallel. Attribution is
   * still precise-first per key inside `groupAndCompute` (window spans are
   * used only for keys whose ids found no agent span), so reading the windows
   * up front costs one indexed query and cannot misattribute. A store failure
   * yields `status: 'error'` for the chunk, never "no spans".
   */
  async forRuns(runIds: string[], hints?: BatchMetricsHints): Promise<MetricsResult[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (valid.length === 0) return [];
    const CHUNK = 50;
    const results: MetricsResult[] = [];
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      const lookups = buildChunkLookups(chunk, hints?.sessionIdByRunId, hints?.traceIdByRunId, hints?.agentsByRunId);
      try {
        const exactIds = [...lookups.runIdCorrelators, ...lookups.sessionIdToRunId.keys(), ...lookups.traceIdToRunId.keys()];
        const allHints = [...lookups.hintsByServiceName.values()].flat().map((h) => h.hint);
        // Mixed chunk: keys' runs happened at different times → the ids need the
        // full lookback; the hints' windows are inside it.
        const scan = this.traces.window({}, false);
        const { sources, truncated } = await this.traces.fetchBoth(
          exactIds,
          { runIds: lookups.runIdCorrelators, traceIds: [...lookups.traceIdToRunId.keys()], agents: allHints.length ? allHints : undefined },
          true,
          scan
        );

        const unique = [...sources].sort((x, y) => Date.parse(x.startTime || '') - Date.parse(y.startTime || ''));
        results.push(...groupAndCompute(chunk, unique, lookups, truncated));
      } catch (e: any) {
        const c = classifyCloudWatchError(e);
        console.warn(`[CloudWatchMetrics] span query failed for ${chunk.length} run id(s): ${c.message}`);
        results.push(...chunk.map((id) => failedMetricsResult(id, c.message)));
      }
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
    const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.reader = reader ?? new CloudWatchReader({ region: options.region, profile: options.profile });
    const traces = new CloudWatchTracesOperations(this.reader, this.logGroups.traces, lookbackMs, maxWindowMs);
    this.traces = traces;
    this.logs = new CloudWatchLogsOperations(this.reader, this.logGroups.logs, options.logsLookbackMs ?? DEFAULT_LOGS_LOOKBACK_MS, maxWindowMs, traces);
    this.metrics = new CloudWatchMetricsOperations(traces);
  }

  async health(): Promise<HealthStatus> {
    try {
      const { names: groups } = await this.reader.describeLogGroups(this.logGroups.traces);
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
    return (await this.reader.describeLogGroups(logGroupTemplatePrefix(this.logGroups.logs))).names;
  }

  isConfigured(): boolean {
    return Boolean(this.options.region);
  }

  describe(): ObservabilityBackendInfo {
    return { type: 'cloudwatch', target: this.logGroups.traces, region: this.options.region };
  }
}
