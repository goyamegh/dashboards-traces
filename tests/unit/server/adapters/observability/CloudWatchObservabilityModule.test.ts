/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CloudWatchObservabilityModule,
  buildTracesInsightsQuery,
  buildRunSpansInsightsQuery,
  traceIdFilterPattern,
  q,
} from '@/server/adapters/observability/CloudWatchObservabilityModule';
import type { ICloudWatchReader, FilterEventsResult, InsightsRow } from '@/server/adapters/observability/cloudwatch/CloudWatchReader';
import { classifyCloudWatchError } from '@/server/adapters/observability/cloudwatch/CloudWatchReader';
import {
  cloudWatchSpanToSource,
  cloudWatchLogToEntry,
  nanosToIso,
  statusCodeToNumber,
  parseSpanRecord,
  resolveLogGroupTemplate,
  logGroupTemplatePrefix,
  type CloudWatchSpanRecord,
} from '@/server/adapters/observability/cloudwatch/recordMappers';
import { transformSpan } from '@/server/services/tracesService';
import { categorizeSpan } from '@/services/traces/spanCategorization';
import type { Span } from '@/types';
import spanFixture from '../../../../fixtures/cloudwatch/aws-spans-trace.json';
import logFixture from '../../../../fixtures/cloudwatch/otel-logs.json';

const TRACE = 'a54f35c518ca4fe4b86b07f10aeea457';
const SERVICE = 'demo-retrieval-agent';
const RUN = 'cw-run-2';
const records = spanFixture as unknown as CloudWatchSpanRecord[];
const spanMessages = records.map((r) => JSON.stringify(r));
const logMessages = (logFixture as unknown[]).map((r) => JSON.stringify(r));
const T0_MS = Math.floor(Number(records[0].startTimeUnixNano) / 1e6);

/** In-memory stand-in for CloudWatch Logs: both read paths see the same records. */
class FakeReader implements ICloudWatchReader {
  calls: { filter: any[]; insights: any[]; describe: string[] } = { filter: [], insights: [], describe: [] };
  groups: Record<string, string[]> = { 'aws/spans': spanMessages, [`/agent-health/${SERVICE}`]: logMessages };
  incompleteFilter = false;
  failInsights?: Error;

  async filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number }): Promise<FilterEventsResult> {
    this.calls.filter.push(opts);
    const msgs = this.groups[opts.logGroup];
    if (!msgs) {
      const err: any = new Error('The specified log group does not exist.');
      err.name = 'ResourceNotFoundException';
      throw err;
    }
    if (this.incompleteFilter) return { events: [], complete: false };
    // Emulate the JSON metric-filter `{ $.traceId = "X" }` and quoted-term patterns.
    const m = /\{ \$\.traceId = "([0-9a-f]+)" \}/.exec(opts.pattern);
    const term = !m && opts.pattern ? JSON.parse(opts.pattern) : null;
    const events = msgs
      .filter((s) => (m ? JSON.parse(s).traceId === m[1] : term ? s.includes(term) : true))
      .map((s) => ({ message: s, timestamp: T0_MS }));
    return { events: events.slice(0, opts.limit), complete: true };
  }

  async insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number }): Promise<InsightsRow[]> {
    this.calls.insights.push(opts);
    if (this.failInsights) throw this.failInsights;
    // The fake returns the whole group; the module's in-memory predicate must do the filtering.
    return opts.logGroups.flatMap((g) => (this.groups[g] || []).map((m) => ({ '@message': m })));
  }

  async describeLogGroups(prefix: string): Promise<string[]> {
    this.calls.describe.push(prefix);
    return Object.keys(this.groups).filter((g) => g.startsWith(prefix));
  }
}

function mod(reader: FakeReader, logGroups?: { traces?: string; logs?: string }) {
  return new CloudWatchObservabilityModule({ region: 'us-east-1', profile: 'default', logGroups }, reader);
}

describe('recordMappers', () => {
  it('maps an aws/spans record to the plain-raw shape transformSpan understands', () => {
    const root = records.find((r) => r.name === 'POST /invoke')!;
    const src = cloudWatchSpanToSource(root);
    expect(src).toMatchObject({
      traceId: TRACE,
      spanId: 'aaad0bc29275b362',
      parentSpanId: 'b7ad6b7169203331',
      name: 'POST /invoke',
      kind: 'SERVER',
      serviceName: SERVICE,
      durationInNanos: 11442 * 1e6,
      status: { code: 1 },
    });
    expect(src.startTime).toBe(nanosToIso(root.startTimeUnixNano));
    expect(src.attributes!['service.name']).toBe(SERVICE);
    expect(src.instrumentationScope).toEqual({ name: 'demo_agent', version: '' });

    const n = transformSpan(src);
    expect(n.status).toBe('OK');
    expect(n.duration).toBe(11442);
    expect(n.attributes['service.name']).toBe(SERVICE);
    expect(n.attributes['spanKind']).toBe('SERVER');
    expect(n.attributes['agent_health.run.id']).toBe(RUN);
  });

  it('categorizes the mapped tree with the shared rules (AGENT / LLM / TOOL)', () => {
    const byName = (name: string) => categorizeSpan(transformSpan(cloudWatchSpanToSource(records.find((r) => r.name === name)!)) as unknown as Span).category;
    expect(byName('invoke_agent demo-retrieval-agent')).toBe('AGENT');
    expect(byName('chat')).toBe('LLM');
    expect(byName('execute_tool run_query')).toBe('TOOL');
  });

  it('handles nanos as strings, string status codes, and missing fields', () => {
    expect(nanosToIso('1788467284282849057')).toBe('2026-09-03T20:28:04.282Z');
    expect(nanosToIso(undefined)).toBeUndefined();
    expect(nanosToIso('abc')).toBeUndefined();
    expect(statusCodeToNumber('ERROR')).toBe(2);
    expect(statusCodeToNumber('OK')).toBe(1);
    expect(statusCodeToNumber('UNSET')).toBe(0);
    expect(statusCodeToNumber(2)).toBe(2);
    expect(statusCodeToNumber(undefined)).toBe(0);
    const bare = cloudWatchSpanToSource({ traceId: TRACE, spanId: 'x', startTimeUnixNano: '1788467284282849057', endTimeUnixNano: '1788467284283849057' });
    expect(bare.durationInNanos).toBe(1_000_000);
    expect(bare.parentSpanId).toBeUndefined();
    expect(bare.events).toEqual([]);
  });

  it('parseSpanRecord rejects non-span JSON and garbage', () => {
    expect(parseSpanRecord('not json')).toBeNull();
    expect(parseSpanRecord('{"traceId":"x"}')).toBeNull();
    expect(parseSpanRecord(spanMessages[0])).not.toBeNull();
  });

  it('maps an OTel log record and a plain-text line', () => {
    const e = cloudWatchLogToEntry(logMessages[1], T0_MS, `/agent-health/${SERVICE}`);
    expect(e).toMatchObject({
      message: 'search ok datasource=ds-demo index=demo-kb hits=1 total=1 took_ms=2',
      level: 'info',
      source: SERVICE,
      traceId: TRACE,
      spanId: 'b93daa8692261d13',
      index: `/agent-health/${SERVICE}`,
    });
    expect(Date.parse(e.timestamp)).toBe(T0_MS + 8000);
    const plain = cloudWatchLogToEntry('hello world', 1700000000000, 'g');
    expect(plain).toMatchObject({ message: 'hello world', level: 'info', timestamp: '2023-11-14T22:13:20.000Z' });
  });

  it('resolves the per-service log-group template', () => {
    expect(resolveLogGroupTemplate('/agent-health/{service.name}', 'svc')).toBe('/agent-health/svc');
    expect(resolveLogGroupTemplate('/agent-health/{service.name}', undefined)).toBeNull();
    expect(resolveLogGroupTemplate('/fixed/group', undefined)).toBe('/fixed/group');
    expect(logGroupTemplatePrefix('/agent-health/{service.name}')).toBe('/agent-health/');
    expect(logGroupTemplatePrefix('/fixed')).toBe('/fixed');
  });
});

describe('Logs Insights query builder', () => {
  it('quotes and escapes string literals', () => {
    expect(q('plain')).toBe('"plain"');
    expect(q('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('mirrors the OpenSearch DSL: A/B/C/D clauses, union vs intersection, must-filters', () => {
    const query = buildTracesInsightsQuery(
      {
        traceId: TRACE,
        runIds: ['r1', '', 'r2'],
        agents: [{ serviceName: SERVICE, startedAt: 1000, endedAt: 2000, sessionId: 'sess-1' }],
        sessionId: 'sess-2',
        startTime: 500,
        endTime: 3000,
        serviceName: 'svc-x',
        textSearch: 'needle (1)',
      },
      true
    );
    expect(query).toContain('fields @message');
    expect(query).toContain(`traceId = "${TRACE}"`);
    expect(query).toContain('`attributes.agent_health.run.id` in ["r1", "r2"]');
    expect(query).toContain('`attributes.gen_ai.conversation.id` in ["r1", "r2"]');
    expect(query).toContain('`resource.attributes.service.name` = "demo-retrieval-agent"');
    expect(query).toContain('startTimeUnixNano >= 1000000000 and startTimeUnixNano <= 2000000000');
    expect(query).toContain('`attributes.session.id` = "sess-1"');
    expect(query).toContain('`attributes.session.id` = "sess-2"');
    expect(query).toContain(' or ');
    expect(query).toContain('startTimeUnixNano >= 500000000');
    expect(query).toContain('startTimeUnixNano <= 3000000000');
    expect(query).toContain('`attributes.gen_ai.agent.name` = "svc-x"');
    expect(query).toContain('@message like /(?i)needle \\(1\\)/');
    expect(query).toMatch(/sort startTimeUnixNano desc \| limit 10000$/);

    const intersect = buildTracesInsightsQuery({ traceId: TRACE, runIds: ['r1'] }, false);
    expect(intersect).toContain(' and (`attributes.agent_health.run.id`');
    expect(intersect).not.toContain(' or (`attributes.agent_health.run.id`');
  });

  it('builds a time-only browse query and the batch run-span query', () => {
    const browse = buildTracesInsightsQuery({ startTime: 1000, endTime: 2000 }, false);
    expect(browse).toBe('fields @message | filter startTimeUnixNano >= 1000000000 and startTimeUnixNano <= 2000000000 | sort startTimeUnixNano desc | limit 10000');
    expect(buildRunSpansInsightsQuery(['a', 'b'])).toContain('`attributes.agent_health.run.id` in ["a", "b"] or `attributes.gen_ai.conversation.id` in ["a", "b"]');
    expect(traceIdFilterPattern(TRACE)).toBe(`{ $.traceId = "${TRACE}" }`);
  });
});

describe('CloudWatchObservabilityModule', () => {
  let reader: FakeReader;
  beforeEach(() => {
    reader = new FakeReader();
  });

  describe('traces', () => {
    it('requires an id filter or a time range', async () => {
      await expect(mod(reader).traces.query({})).rejects.toThrow(/traceId, runIds, sessionId, agents, or time range/);
    });

    it('traceId-only lookup uses the synchronous FilterLogEvents path and returns the whole tree', async () => {
      const res = await mod(reader).traces.query({ traceId: TRACE, size: 100 });
      expect(reader.calls.filter).toHaveLength(1);
      expect(reader.calls.insights).toHaveLength(0);
      expect(reader.calls.filter[0]).toMatchObject({ logGroup: 'aws/spans', pattern: traceIdFilterPattern(TRACE) });
      expect(res.total).toBe(12);
      expect(res.spans).toHaveLength(12);
      expect(res.hasMore).toBe(false);
      // newest first, every span normalized
      const times = res.spans.map((s) => Date.parse(s.startTime));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const root = res.spans.find((s) => s.spanId === 'aaad0bc29275b362')!;
      expect(root.status).toBe('OK');
      expect(root.attributes!['service.name']).toBe(SERVICE);
      // 14-day default lookback when no bounds are given
      expect(reader.calls.filter[0].endMs - reader.calls.filter[0].startMs).toBe(14 * 24 * 3600 * 1000);
    });

    it('falls back to Logs Insights when the bounded FilterLogEvents scan is incomplete', async () => {
      reader.incompleteFilter = true;
      const res = await mod(reader).traces.query({ traceId: TRACE });
      expect(reader.calls.filter).toHaveLength(1);
      expect(reader.calls.insights).toHaveLength(1);
      expect(res.total).toBe(12);
    });

    it('run-report shape (traceId + runIds + agents) goes through Insights with union semantics', async () => {
      const res = await mod(reader).traces.query({
        traceId: 'f'.repeat(32), // trace id that matches nothing …
        runIds: [RUN], // … but Strategy B does
        agents: [{ serviceName: 'other-service', startedAt: 0, endedAt: 1 }],
        size: 1000,
      });
      expect(reader.calls.insights).toHaveLength(1);
      expect(reader.calls.insights[0].query).toContain(`"${RUN}"`);
      expect(res.total).toBe(12);
    });

    it('Strategy C: service.name + window matches; outside the window nothing matches', async () => {
      const inWindow = await mod(reader).traces.query({ agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] });
      expect(inWindow.total).toBe(12);
      const outside = await mod(reader).traces.query({ agents: [{ serviceName: SERVICE, startedAt: T0_MS + 120_000, endedAt: T0_MS + 180_000 }] });
      expect(outside.total).toBe(0);
    });

    it('Strategy B on the OTEL-standard gen_ai.conversation.id and in-memory must-filters', async () => {
      const bySession = await mod(reader).traces.query({ runIds: ['cw-sess-2'] });
      expect(bySession.total).toBe(12);
      const wrongService = await mod(reader).traces.query({ traceId: TRACE, serviceName: 'someone-else' });
      expect(wrongService.total).toBe(0);
      const text = await mod(reader).traces.query({ traceId: TRACE, textSearch: 'run_query' });
      expect(text.spans.map((s) => s.name)).toEqual(['execute_tool run_query']);
    });

    it('paginates with an offset cursor', async () => {
      const m = mod(reader);
      const p1 = await m.traces.query({ traceId: TRACE, size: 5 });
      expect(p1.spans).toHaveLength(5);
      expect(p1.hasMore).toBe(true);
      const p2 = await m.traces.query({ traceId: TRACE, size: 5, cursor: p1.nextCursor! });
      const p3 = await m.traces.query({ traceId: TRACE, size: 5, cursor: p2.nextCursor! });
      expect(p3.spans).toHaveLength(2);
      expect(p3.hasMore).toBe(false);
      const ids = new Set([...p1.spans, ...p2.spans, ...p3.spans].map((s) => s.spanId));
      expect(ids.size).toBe(12);
    });

    it('dedupes a span delivered twice', async () => {
      reader.groups['aws/spans'] = [...spanMessages, spanMessages[0]];
      const res = await mod(reader).traces.query({ traceId: TRACE });
      expect(res.total).toBe(12);
    });

    it('getByTraceId / getByRunIds convenience wrappers', async () => {
      const m = mod(reader);
      expect(await m.traces.getByTraceId(TRACE)).toHaveLength(12);
      expect(await m.traces.getByRunIds([RUN])).toHaveLength(12);
      expect(await m.traces.getByRunIds([''])).toEqual([]);
    });

    it('honours a custom traces log group', async () => {
      reader.groups['custom/spans'] = spanMessages;
      await mod(reader, { traces: 'custom/spans' }).traces.query({ traceId: TRACE });
      expect(reader.calls.filter[0].logGroup).toBe('custom/spans');
    });
  });

  describe('logs', () => {
    it('resolves the per-service group and correlates by traceId', async () => {
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: SERVICE });
      expect(reader.calls.filter[0]).toMatchObject({ logGroup: `/agent-health/${SERVICE}`, pattern: traceIdFilterPattern(TRACE) });
      expect(res.total).toBe(3);
      expect(res.logs.map((l) => l.spanId)).toContain('b93daa8692261d13');
      // newest first
      expect(res.logs[0].message).toMatch(/planner request ok/);
    });

    it('without a serviceName, searches every group under the template prefix', async () => {
      reader.groups['/agent-health/other-agent'] = [];
      const res = await mod(reader).logs.query({ traceId: TRACE });
      expect(reader.calls.describe).toEqual(['/agent-health/']);
      expect(reader.calls.filter.map((c) => c.logGroup).sort()).toEqual([`/agent-health/${SERVICE}`, '/agent-health/other-agent']);
      expect(res.total).toBe(3);
    });

    it('a missing per-service group is empty, not an error', async () => {
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: 'never-logged' });
      expect(res).toEqual({ logs: [], total: 0 });
    });

    it('runId and free-text use quoted-term patterns; text narrows an id lookup in memory', async () => {
      const m = mod(reader);
      await m.logs.query({ runId: 'cw-sess-2', serviceName: SERVICE });
      expect(reader.calls.filter.at(-1).pattern).toBe('"cw-sess-2"');
      await m.logs.query({ query: 'search ok', serviceName: SERVICE, startTime: 1, endTime: 2 });
      expect(reader.calls.filter.at(-1)).toMatchObject({ pattern: '"search ok"', startMs: 1, endMs: 2 });
      const narrowed = await m.logs.query({ traceId: TRACE, serviceName: SERVICE, query: 'hits=1' });
      expect(narrowed.total).toBe(1);
    });

    it('browsing without ids defaults to the last hour; id lookups to the full lookback', async () => {
      const m = mod(reader);
      await m.logs.query({ serviceName: SERVICE });
      const browse = reader.calls.filter.at(-1);
      expect(browse.endMs - browse.startMs).toBe(60 * 60 * 1000);
      await m.logs.query({ serviceName: SERVICE, traceId: TRACE });
      const byId = reader.calls.filter.at(-1);
      expect(byId.endMs - byId.startMs).toBe(14 * 24 * 3600 * 1000);
    });
  });

  describe('metrics', () => {
    it('forRun fetches the run spans through Insights and applies the shared math (no double count)', async () => {
      const m = await mod(reader).metrics.forRun(RUN);
      expect(reader.calls.insights[0].query).toBe(buildRunSpansInsightsQuery([RUN]));
      expect(m).toMatchObject({ runId: RUN, traceId: TRACE, inputTokens: 21476, outputTokens: 843, llmCalls: 3, toolCalls: 3, status: 'success' });
    });

    it('forRuns groups spans per run and returns empty metrics for unknown runs', async () => {
      const [a, b] = await mod(reader).metrics.forRuns([RUN, 'unknown-run']);
      expect(a.totalTokens).toBe(22319);
      expect(b).toMatchObject({ runId: 'unknown-run', totalTokens: 0, status: 'pending' });
      expect(await mod(reader).metrics.forRuns([])).toEqual([]);
    });

    it('a failing Insights query degrades to empty metrics instead of throwing', async () => {
      reader.failInsights = new Error('ThrottlingException');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const [m] = await mod(reader).metrics.forRuns([RUN]);
      expect(m.totalTokens).toBe(0);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('health / describe', () => {
    it('is healthy when the traces log group exists', async () => {
      await expect(mod(reader).health()).resolves.toEqual({ status: 'ok', index: 'aws/spans' });
      expect(mod(reader).describe()).toEqual({ type: 'cloudwatch', target: 'aws/spans', region: 'us-east-1' });
      expect(mod(reader).isConfigured()).toBe(true);
    });

    it('reports a missing traces group as index_not_found with the Transaction Search hint', async () => {
      delete reader.groups['aws/spans'];
      const h = await mod(reader).health();
      expect(h.status).toBe('error');
      expect(h.errorCategory).toBe('index_not_found');
      expect(h.suggestion).toMatch(/Transaction Search/);
    });

    it('classifies AWS SDK errors for the health contract', async () => {
      const err = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
      expect(classifyCloudWatchError(err('ExpiredTokenException')).category).toBe('auth');
      expect(classifyCloudWatchError(err('AccessDeniedException', 403)).category).toBe('auth');
      expect(classifyCloudWatchError(err('ResourceNotFoundException')).category).toBe('index_not_found');
      expect(classifyCloudWatchError(new Error('getaddrinfo ENOTFOUND logs.us-east-1.amazonaws.com')).category).toBe('connection');
      expect(classifyCloudWatchError(err('SomethingElse')).category).toBe('unknown');
      reader.describeLogGroups = async () => { throw err('ExpiredTokenException', 403); };
      const h = await mod(reader).health();
      expect(h).toMatchObject({ status: 'error', errorCategory: 'auth' });
    });

    it('lists log groups under the logs template prefix', async () => {
      await expect(mod(reader).listLogGroups()).resolves.toEqual([`/agent-health/${SERVICE}`]);
    });
  });
});
