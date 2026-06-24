/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for issue #296 — trace correlation against the OTEL-faithful
 * Data Prepper `trace-analytics-plain-raw` span schema.
 *
 * Exercises the real service path end-to-end:
 *   fetchTraces (query build -> client.search -> transformSpan)
 *   computeMetrics / computeBatchMetrics (query build -> aggregation)
 *
 * The fake OpenSearch client below stores spans in the plain-raw shape that
 * stock Data Prepper produces (a nested `attributes` object keyed by literal
 * dotted OTel names, e.g. attributes['agent_health.run.id']) and resolves query
 * fields the way OpenSearch maps them. If the services queried the legacy
 * custom `span.attributes.gen_ai@request@id` shape, field resolution returns
 * `undefined`, the fake index returns 0 hits, and these tests fail — exactly
 * reproducing the bug Ulrich hit (`trace_timeout`, empty metrics).
 *
 * Run: npm test -- --testPathPatterns=plainRawCorrelation.integration
 */

import { fetchTraces } from '@/server/services/tracesService';
import { computeMetrics, computeBatchMetrics } from '@/server/services/metricsService';

// ---------------------------------------------------------------------------
// Plain-raw span fixtures (matches Data Prepper trace-analytics-plain-raw and
// the live evidence in issue #296).
// ---------------------------------------------------------------------------
function plainRawSpan(overrides: Record<string, any>): Record<string, any> {
  return {
    traceId: 'trace-AAA',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    parentSpanId: '',
    name: 'span',
    kind: 'SPAN_KIND_INTERNAL',
    serviceName: 'retail-agent',
    startTime: '2026-06-17T09:00:00.000000000Z',
    endTime: '2026-06-17T09:00:01.000000000Z',
    durationInNanos: 1_000_000_000,
    status: { code: 1, message: '' },
    resource: { attributes: { 'service.name': 'retail-agent' } },
    attributes: {},
    ...overrides,
  };
}

const RUN_A = 'run-1781686816814-a4e3j7lsj';
const RUN_B = 'run-0000000000000-zzzzzzzzz';

const INDEX: Record<string, any>[] = [
  // --- run A: root + one LLM call + one tool call ---
  plainRawSpan({
    spanId: 'root-A',
    name: 'invoke_agent Strands Agent',
    durationInNanos: 3_000_000_000,
    attributes: {
      'agent_health.run.id': RUN_A,
      'gen_ai.conversation.id': 'thread-AAA',
      'gen_ai.agent.name': 'retail-agent',
    },
  }),
  plainRawSpan({
    spanId: 'llm-A',
    name: 'chat us.amazon.nova-pro-v1:0',
    attributes: {
      'agent_health.run.id': RUN_A,
      'gen_ai.request.model': 'us.amazon.nova-pro-v1:0',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
    },
  }),
  plainRawSpan({
    spanId: 'tool-A',
    name: 'execute_tool search_products',
    attributes: {
      'agent_health.run.id': RUN_A,
      'gen_ai.tool.name': 'search_products',
    },
  }),
  // --- run B: decoy, must NOT bleed into run A's correlation ---
  plainRawSpan({
    spanId: 'root-B',
    traceId: 'trace-BBB',
    name: 'invoke_agent Strands Agent',
    attributes: {
      'agent_health.run.id': RUN_B,
      'gen_ai.usage.input_tokens': 999,
    },
  }),
  // --- #313: span correlated ONLY by the OTEL-standard gen_ai.conversation.id
  // (no agent_health.run.id). A subprocess/eval span that adopted the standard
  // attribute must still be found by a runIds query. ---
  plainRawSpan({
    spanId: 'conv-only',
    traceId: 'trace-CONV',
    name: 'chat',
    attributes: {
      'gen_ai.conversation.id': 'conv-XYZ',
      'gen_ai.usage.input_tokens': 42,
    },
  }),
  // --- #313: span correlated ONLY by session.id (no run.id / conversation.id),
  // emitted by a subprocess agent (Claude Code). Found via Strategy D. The
  // service name + time deliberately fall OUTSIDE any window we pass, so only
  // the session.id clause can surface it. ---
  plainRawSpan({
    spanId: 'sess-only',
    traceId: 'trace-SESS',
    serviceName: 'claude-code-agent',
    startTime: '2020-01-01T00:00:00.000000000Z',
    attributes: {
      'session.id': 'sess-D',
      'gen_ai.tool.name': 'read_file',
    },
  }),
];

// ---------------------------------------------------------------------------
// Fake OpenSearch client that resolves query fields against the plain-raw
// document shape, mirroring OpenSearch's dot-path mapping.
// ---------------------------------------------------------------------------
function resolveField(doc: Record<string, any>, field: string): unknown {
  if (field.startsWith('attributes.')) return doc.attributes?.[field.slice('attributes.'.length)];
  if (field.startsWith('resource.attributes.')) {
    return doc.resource?.attributes?.[field.slice('resource.attributes.'.length)];
  }
  return doc[field];
}

function matches(clause: any, doc: Record<string, any>): boolean {
  if (!clause || typeof clause !== 'object') return true;
  if (clause.term) {
    const [field, val] = Object.entries(clause.term)[0] as [string, unknown];
    return resolveField(doc, field) === val;
  }
  if (clause.terms) {
    const [field, vals] = Object.entries(clause.terms)[0] as [string, unknown[]];
    return (vals as unknown[]).includes(resolveField(doc, field) as never);
  }
  if (clause.range) {
    const [field, bounds] = Object.entries(clause.range)[0] as [string, any];
    const t = new Date(String(resolveField(doc, field))).getTime();
    if (bounds.gte !== undefined && t < new Date(bounds.gte).getTime()) return false;
    if (bounds.lte !== undefined && t > new Date(bounds.lte).getTime()) return false;
    return true;
  }
  if (clause.query_string) return true; // text-search not under test here
  if (clause.bool) {
    const { must = [], should = [], minimum_should_match } = clause.bool;
    const mustOk = (must as any[]).every((c) => matches(c, doc));
    const shouldOk =
      (should as any[]).length === 0 || (minimum_should_match ?? 0) === 0
        ? true
        : (should as any[]).some((c) => matches(c, doc));
    return mustOk && shouldOk;
  }
  return true;
}

function createPlainRawClient() {
  const search = jest.fn(async ({ body }: any) => {
    const hits = INDEX.filter((d) => matches(body.query, d)).slice(0, body.size ?? 100);
    return { body: { hits: { hits: hits.map((_source) => ({ _source })), total: { value: hits.length } } } };
  });
  return { search } as any;
}

describe('plain-raw trace correlation (#296)', () => {
  describe('fetchTraces', () => {
    it('correlates a run by runId against attributes.agent_health.run.id and normalizes attributes', async () => {
      const client = createPlainRawClient();

      const result = await fetchTraces({ runIds: [RUN_A] }, client);

      // 3 spans for run A, none from the run-B decoy.
      expect(result.spans).toHaveLength(3);
      expect(result.spans.every((s) => s.attributes['agent_health.run.id'] === RUN_A)).toBe(true);
      expect(result.spans.map((s) => s.spanId).sort()).toEqual(['llm-A', 'root-A', 'tool-A']);

      // transformSpan surfaced the nested dotted keys as normalized attributes.
      const llm = result.spans.find((s) => s.spanId === 'llm-A')!;
      expect(llm.attributes['gen_ai.request.model']).toBe('us.amazon.nova-pro-v1:0');
      expect(llm.attributes['gen_ai.usage.input_tokens']).toBe(1200);
    });

    it('queries the plain-raw field path, not the legacy @ shape', async () => {
      const client = createPlainRawClient();
      await fetchTraces({ runIds: [RUN_A] }, client);

      const sent = JSON.stringify(client.search.mock.calls[0][0].body.query);
      expect(sent).toContain('attributes.agent_health.run.id');
      expect(sent).not.toContain('gen_ai@request@id');
    });

    it('also correlates a runId against the OTEL-standard gen_ai.conversation.id (#313)', async () => {
      const client = createPlainRawClient();

      // 'conv-XYZ' is stamped only as gen_ai.conversation.id (no run.id), yet a
      // runIds query must still surface it via the Strategy-B OR branch.
      const result = await fetchTraces({ runIds: ['conv-XYZ'] }, client);

      expect(result.spans.map((s) => s.spanId)).toEqual(['conv-only']);
    });

    it('Strategy D: correlates a subprocess span by session.id even when service+window miss (#313)', async () => {
      const client = createPlainRawClient();

      // runIds + agents → union. The sess-only span has no run.id and a
      // service/time outside the window, so ONLY the session.id clause matches.
      const result = await fetchTraces({
        runIds: [RUN_A],
        agents: [{
          serviceName: 'claude-code-agent',
          startedAt: Date.parse('2026-06-17T08:00:00Z'),
          endedAt: Date.parse('2026-06-17T10:00:00Z'),
          sessionId: 'sess-D',
        }],
      }, client);

      const ids = result.spans.map((s) => s.spanId).sort();
      // Run A's 3 spans (Strategy B) PLUS the session-correlated span (Strategy D).
      expect(ids).toEqual(['llm-A', 'root-A', 'sess-only', 'tool-A']);
    });
  });

  describe('computeMetrics / computeBatchMetrics', () => {
    it('computes single-run metrics from plain-raw nested attributes', async () => {
      const client = createPlainRawClient();

      const m = await computeMetrics(RUN_A, { client });

      expect(m.runId).toBe(RUN_A);
      expect(m.inputTokens).toBe(1200);
      expect(m.outputTokens).toBe(300);
      expect(m.totalTokens).toBe(1500);
      expect(m.llmCalls).toBe(1);
      expect(m.toolsUsed).toEqual(['search_products']);
      expect(m.status).toBe('success');
    });

    it('computes batch metrics and isolates runs (no decoy bleed)', async () => {
      const client = createPlainRawClient();

      const [a, b] = await computeBatchMetrics([RUN_A, RUN_B], { client });

      expect(a.runId).toBe(RUN_A);
      expect(a.inputTokens).toBe(1200);
      expect(a.toolCalls).toBe(1);

      // run B only has its own decoy span.
      expect(b.runId).toBe(RUN_B);
      expect(b.inputTokens).toBe(999);
    });
  });
});
