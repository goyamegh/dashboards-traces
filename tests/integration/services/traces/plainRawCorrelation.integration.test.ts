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
 * dotted OTel names, e.g. attributes['gen_ai.request.id']) and resolves query
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
      'gen_ai.request.id': RUN_A,
      'gen_ai.conversation.id': 'thread-AAA',
      'gen_ai.agent.name': 'retail-agent',
    },
  }),
  plainRawSpan({
    spanId: 'llm-A',
    name: 'chat us.amazon.nova-pro-v1:0',
    attributes: {
      'gen_ai.request.id': RUN_A,
      'gen_ai.request.model': 'us.amazon.nova-pro-v1:0',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
    },
  }),
  plainRawSpan({
    spanId: 'tool-A',
    name: 'execute_tool search_products',
    attributes: {
      'gen_ai.request.id': RUN_A,
      'gen_ai.tool.name': 'search_products',
    },
  }),
  // --- run B: decoy, must NOT bleed into run A's correlation ---
  plainRawSpan({
    spanId: 'root-B',
    traceId: 'trace-BBB',
    name: 'invoke_agent Strands Agent',
    attributes: {
      'gen_ai.request.id': RUN_B,
      'gen_ai.usage.input_tokens': 999,
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
    it('correlates a run by runId against attributes.gen_ai.request.id and normalizes attributes', async () => {
      const client = createPlainRawClient();

      const result = await fetchTraces({ runIds: [RUN_A] }, client);

      // 3 spans for run A, none from the run-B decoy.
      expect(result.spans).toHaveLength(3);
      expect(result.spans.every((s) => s.attributes['gen_ai.request.id'] === RUN_A)).toBe(true);
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
      expect(sent).toContain('attributes.gen_ai.request.id');
      expect(sent).not.toContain('gen_ai@request@id');
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
