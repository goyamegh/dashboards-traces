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
import { buildChunkLookups, groupAndCompute, failedMetricsResult, isEvalOrJudgeSpan } from '../../services/metricsService.js';
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

  /** Exact-id path: FilterLogEvents term scan. */
  async fetchExact(ids: string[], scan: { startMs: number; endMs: number }): Promise<FetchedSources> {
    const pattern = idTermsFilterPattern(ids);
    if (!pattern) return { sources: [], truncated: false };
    const res = await this.reader.filterEvents({ logGroup: this.logGroup, pattern, startMs: scan.startMs, endMs: scan.endMs, limit: INSIGHTS_ROW_LIMIT });
    debug('CloudWatchTraces', `FilterLogEvents(${pattern}) → ${res.events.length} records, complete=${res.complete}`);
    return { sources: parseAll(res.events.map((e) => e.message)), truncated: !res.complete };
  }

  /** Window / free-text path: Logs Insights. */
  async fetchWindow(options: TracesQueryOptions, useUnion: boolean, scan: { startMs: number; endMs: number }): Promise<FetchedSources> {
    const res = await this.reader.insights({ logGroups: [this.logGroup], query: buildTracesInsightsQuery(options, useUnion), startMs: scan.startMs, endMs: scan.endMs });
    debug('CloudWatchTraces', `Insights → ${res.rows.length} records, truncated=${res.truncated}`);
    return { sources: parseAll(res.rows.map((r) => r['@message']).filter((m): m is string => typeof m === 'string')), truncated: res.truncated };
  }

  /**
   * Fetch raw span sources for ONE request (the traces route).
   *
   * Exact ids (traceId / runIds / sessionIds) go through FilterLogEvents —
   * synchronous and visible within seconds of ingestion, whereas Logs
   * Insights indexes `aws/spans` with a lag of minutes. The Insights window
   * query runs when the request needs it (agents window / free text) and the
   * exact ids did not already find the AGENT's spans: Agent Health's own
   * eval/judge spans carry the run id too, so a hit consisting only of those
   * must not suppress the fallback (that is the Strategy-C-only agent).
   */
  async fetchSources(options: TracesQueryOptions, useUnion: boolean): Promise<FetchedSources> {
    const { agents, textSearch } = options;
    const scan = this.window(options);
    const exact = await this.fetchExact(exactCorrelatorIds(options), scan);
    const needsWindow = !!(agents && agents.length > 0) || !!(textSearch && textSearch.trim());
    const agentSpanFound = exact.sources.some((src) => !isEvalOrJudgeSpan(src.attributes || {}, src.name));
    const noExact = exactCorrelatorIds(options).length === 0;
    const windowNeeded = noExact || (needsWindow && (!useUnion || !agentSpanFound)) || exact.truncated;
    if (!windowNeeded) return { sources: exact.sources, truncated: exact.truncated || scan.clamped };
    const win = await this.fetchWindow(options, useUnion, scan);
    return { sources: [...exact.sources, ...win.sources], truncated: exact.truncated || win.truncated || scan.clamped };
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
    private readonly maxWindowMs: number
  ) {}

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
    const endMs = endTime ?? now;
    // Id lookups search the lookback; browsing defaults to the last hour.
    let startMs = startTime ?? (traceId || runId ? endMs - this.lookbackMs : endMs - 60 * 60 * 1000);
    const clamped = endMs - startMs > this.maxWindowMs;
    if (clamped) startMs = endMs - this.maxWindowMs;

    let pattern = '';
    if (traceId) pattern = traceIdFilterPattern(traceId);
    else if (runId) pattern = JSON.stringify(runId); // quoted term match anywhere in the event
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
   * Per 50-key chunk: exact ids (run ids, session ids, trace ids) through
   * FilterLogEvents over the lookback; then the Insights window ONLY for keys
   * whose window hints did not get an AGENT span from the exact phase (eval /
   * judge spans do not count — they carry the run id themselves). A store
   * failure yields `status: 'error'` for the chunk, never "no spans".
   * Attribution + math are the shared `groupAndCompute`.
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
        // Mixed chunk: keys' runs happened at different times → full lookback for the id scan.
        const idScan = this.traces.window({}, false);
        const exact = await this.traces.fetchExact(exactIds, idScan);
        let sources = exact.sources;
        let truncated = exact.truncated || idScan.clamped;

        // Which keys already have agent spans by exact id?
        const idSet = new Set(lookups.runIdCorrelators);
        const found = new Set<string>();
        for (const src of exact.sources) {
          const a = src.attributes || {};
          if (isEvalOrJudgeSpan(a, src.name)) continue;
          const key =
            ([a['agent_health.run.id'], a['gen_ai.conversation.id']].find((v) => typeof v === 'string' && idSet.has(v)) as string | undefined) ??
            (typeof a['session.id'] === 'string' ? lookups.sessionIdToRunId.get(a['session.id'] as string) : undefined) ??
            (src.traceId ? lookups.traceIdToRunId.get(src.traceId) : undefined);
          if (key) found.add(key);
        }
        // Window hints of keys the exact phase did not find an agent span for.
        const pendingHints: TracesQueryOptions['agents'] = [];
        for (const list of lookups.hintsByServiceName.values()) {
          for (const { key, hint } of list) if (!found.has(key)) pendingHints.push(hint);
        }
        if (pendingHints.length > 0) {
          const winScan = this.traces.window({ agents: pendingHints });
          const win = await this.traces.fetchWindow({ agents: pendingHints }, true, winScan);
          sources = [...sources, ...win.sources];
          truncated = truncated || win.truncated || winScan.clamped;
        }

        const seen = new Set<string>();
        const unique = sources.filter((src) => (src.spanId && seen.has(src.spanId) ? false : (src.spanId && seen.add(src.spanId), true)));
        unique.sort((x, y) => Date.parse(x.startTime || '') - Date.parse(y.startTime || ''));
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
    this.logs = new CloudWatchLogsOperations(this.reader, this.logGroups.logs, lookbackMs, maxWindowMs);
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
