/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Roll-up-aware token attribution — fixtures from three instrumentation
 * shapes plus partially-instrumented parents. Every expectation states what
 * `main` (sum every span) reports today, so the behaviour change is explicit.
 */

import { selectUsageSpans, sumUsage, readInputTokens, readOutputTokens } from '@/services/traces/tokenUsage';
import { computeTraceSummary } from '@/services/traces/traceSummary';
import { processSpansIntoTree } from '@/services/traces/index';
import { computeMetricsFromSpans } from '@/server/services/metricsService';
import type { Span } from '@/types';

const T0 = Date.parse('2026-03-01T10:00:00Z');
let n = 0;
function span(over: Partial<Span> & { in?: number; out?: number; op?: string; model?: string }): Span {
  const { in: i, out: o, op, model, ...rest } = over;
  const start = T0 + (n++) * 1000;
  return {
    traceId: 't1',
    spanId: rest.spanId ?? `s${n}`,
    name: rest.name ?? op ?? 'span',
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 500).toISOString(),
    status: 'OK',
    ...rest,
    attributes: {
      ...(op ? { 'gen_ai.operation.name': op } : {}),
      ...(model ? { 'gen_ai.request.model': model } : {}),
      ...(i !== undefined ? { 'gen_ai.usage.input_tokens': i } : {}),
      ...(o !== undefined ? { 'gen_ai.usage.output_tokens': o } : {}),
      ...(rest.attributes || {}),
    },
  };
}
const toSource = (s: Span) => ({ ...s, durationInNanos: 500e6, status: { code: 1 }, attributes: s.attributes });
const metrics = (spans: Span[]) => computeMetricsFromSpans('run', spans.map(toSource));
const summary = (spans: Span[]) => computeTraceSummary(processSpansIntoTree(spans));

beforeEach(() => { n = 0; });

// ---------------------------------------------------------------------------
// Shape 1 — Strands: aggregate on invoke_agent EQUALS Σ chat (measured on a real trace)
// ---------------------------------------------------------------------------
const strands = () => [
  span({ spanId: 'agent', op: 'invoke_agent', model: 'm', in: 21476, out: 843 }),
  span({ spanId: 'cycle1', parentSpanId: 'agent', name: 'execute_event_loop_cycle' }),
  span({ spanId: 'chat1', parentSpanId: 'cycle1', op: 'chat', model: 'm', in: 5542, out: 175 }),
  span({ spanId: 'tool1', parentSpanId: 'cycle1', op: 'execute_tool', name: 'execute_tool search_docs', attributes: { 'gen_ai.tool.name': 'search_docs' } }),
  span({ spanId: 'cycle2', parentSpanId: 'agent', name: 'execute_event_loop_cycle' }),
  span({ spanId: 'chat2', parentSpanId: 'cycle2', op: 'chat', model: 'm', in: 7470, out: 325 }),
  span({ spanId: 'cycle3', parentSpanId: 'agent', name: 'execute_event_loop_cycle' }),
  span({ spanId: 'chat3', parentSpanId: 'cycle3', op: 'chat', model: 'm', in: 8464, out: 343 }),
];

// ---------------------------------------------------------------------------
// Shape 2 — LangGraph-style: graph root without usage; node spans without usage;
// per-call LLM spans under nodes (nothing to dedupe — must equal main)
// ---------------------------------------------------------------------------
const langgraph = () => [
  span({ spanId: 'graph', name: 'LangGraph' }),
  span({ spanId: 'planner', parentSpanId: 'graph', name: 'planner' }),
  span({ spanId: 'llm1', parentSpanId: 'planner', op: 'chat', model: 'm', in: 1200, out: 80 }),
  span({ spanId: 'tools', parentSpanId: 'graph', name: 'tools' }),
  span({ spanId: 'tool1', parentSpanId: 'tools', op: 'execute_tool', name: 'execute_tool run_query', attributes: { 'gen_ai.tool.name': 'run_query' } }),
  span({ spanId: 'answer', parentSpanId: 'graph', name: 'answer' }),
  span({ spanId: 'llm2', parentSpanId: 'answer', op: 'chat', model: 'm', in: 2400, out: 160 }),
];

// ---------------------------------------------------------------------------
// Shape 3 — plain OTel with INDEPENDENT nested usage: a span that called a model
// itself, with a child that also called a model (both real) — must equal main
// ---------------------------------------------------------------------------
const independent = () => [
  span({ spanId: 'parent', name: 'handle_request', model: 'm', in: 100, out: 20 }),
  span({ spanId: 'child', parentSpanId: 'parent', name: 'rerank', model: 'm', in: 50, out: 10 }),
];

describe('tokenUsage — readers', () => {
  it('reads input/output tokens with legacy aliases', () => {
    expect(readInputTokens({ 'gen_ai.usage.prompt_tokens': '7' })).toBe(7);
    expect(readOutputTokens({ 'gen_ai.usage.completion_tokens': 3 })).toBe(3);
    expect(readInputTokens(undefined)).toBe(0);
  });
});

describe('Shape 1 — Strands equal roll-up (main: 42,952 / 1,686 / 4 calls)', () => {
  it('counts the three chat spans once; the mirrored invoke_agent is dropped', () => {
    const u = sumUsage(strands());
    expect(u).toMatchObject({ inputTokens: 21476, outputTokens: 843, llmCalls: 3 });
    expect(u.rolledUp.map((s) => s.spanId)).toEqual(['agent']);
    expect(u.aggregates).toEqual([]);
  });
  it('both summers agree', () => {
    expect(metrics(strands())).toMatchObject({ inputTokens: 21476, outputTokens: 843, llmCalls: 3, toolCalls: 1 });
    expect(summary(strands())).toMatchObject({ inputTokens: 21476, outputTokens: 843, totalTokens: 22319, peakInputTokens: 8464 });
  });
});

describe('Shape 2 — LangGraph-style per-call usage (identical to main: 3,600 / 240 / 2 calls)', () => {
  it('nothing is folded — the same numbers main reports', () => {
    expect(sumUsage(langgraph())).toMatchObject({ inputTokens: 3600, outputTokens: 240, llmCalls: 2, rolledUp: [], aggregates: [] });
    expect(metrics(langgraph())).toMatchObject({ inputTokens: 3600, outputTokens: 240, llmCalls: 2 }); // toolCalls follows main's name heuristic (unchanged here)
    expect(summary(langgraph())).toMatchObject({ inputTokens: 3600, outputTokens: 240 });
  });
});

describe('Shape 3 — independent nested usage (identical to main: 150 / 30 / 2 calls) — reviewer probe', () => {
  it('a plain parent with its own usage over a child with usage is NOT a roll-up', () => {
    const u = sumUsage(independent());
    expect(u).toMatchObject({ inputTokens: 150, outputTokens: 30, llmCalls: 2, rolledUp: [], aggregates: [] });
    expect(metrics(independent())).toMatchObject({ inputTokens: 150, outputTokens: 30, llmCalls: 2 });
    expect(summary(independent())).toMatchObject({ inputTokens: 150, outputTokens: 30 });
  });
  it('a plain parent that merely EXCEEDS its children is also summed (main: 1,300 / 100)', () => {
    const tree = [
      span({ spanId: 'root', model: 'm', in: 1000, out: 100 }),
      span({ spanId: 'c1', parentSpanId: 'root', model: 'm', in: 300, out: 0 }),
    ];
    expect(sumUsage(tree)).toMatchObject({ inputTokens: 1300, outputTokens: 100, llmCalls: 2 });
  });
  it('a roll-up must match on BOTH dimensions — a larger combined total is not enough', () => {
    const tree = [
      span({ spanId: 'root', in: 500, out: 10 }),
      span({ spanId: 'c1', parentSpanId: 'root', in: 500, out: 50 }),
    ];
    expect(sumUsage(tree)).toMatchObject({ inputTokens: 1000, outputTokens: 60 });
  });
});

describe('Partially-instrumented agent aggregate (rule b) — the remainder is preserved', () => {
  it('invoke_agent 1000/100 over one reported chat 300/0 → 1000/100 (main: 1300/100), calls = 1 reported + 1 remainder', () => {
    const tree = [
      span({ spanId: 'agent', op: 'invoke_agent', model: 'm', in: 1000, out: 100 }),
      span({ spanId: 'c1', parentSpanId: 'agent', op: 'chat', model: 'm', in: 300, out: 0 }),
    ];
    const u = sumUsage(tree);
    expect(u).toMatchObject({ inputTokens: 1000, outputTokens: 100, llmCalls: 2 });
    expect(u.aggregates).toHaveLength(1);
    expect(u.aggregates[0].remainderCalls).toBe(1);
    expect(metrics(tree)).toMatchObject({ inputTokens: 1000, outputTokens: 100, llmCalls: 2 });
  });
  it('invoke_agent 100/20 over chat 50/10 is read as a partial aggregate → 100/20, 2 calls (documented ambiguity; main: 150/30)', () => {
    const tree = [
      span({ spanId: 'agent', op: 'invoke_agent', model: 'm', in: 100, out: 20 }),
      span({ spanId: 'c1', parentSpanId: 'agent', op: 'chat', model: 'm', in: 50, out: 10 }),
    ];
    expect(sumUsage(tree)).toMatchObject({ inputTokens: 100, outputTokens: 20, llmCalls: 2 });
  });
  it('an agent parent whose children are NOT LLM-call spans is not an aggregate (summed, as on main)', () => {
    const tree = [
      span({ spanId: 'agent', op: 'invoke_agent', in: 100, out: 20 }),
      span({ spanId: 'c1', parentSpanId: 'agent', name: 'rerank', in: 50, out: 10 }), // no gen_ai.operation.name
    ];
    expect(sumUsage(tree)).toMatchObject({ inputTokens: 150, outputTokens: 30 });
  });
  it('an agent parent reporting LESS than its children is not an aggregate (summed, as on main)', () => {
    const tree = [
      span({ spanId: 'agent', op: 'invoke_agent', in: 10, out: 1 }),
      span({ spanId: 'c1', parentSpanId: 'agent', op: 'chat', in: 50, out: 10 }),
    ];
    expect(sumUsage(tree)).toMatchObject({ inputTokens: 60, outputTokens: 11 });
  });
});

describe('edge cases', () => {
  it('a root that is the only instrumented span still counts', () => {
    expect(sumUsage([span({ spanId: 'r', in: 10, out: 2 })])).toMatchObject({ inputTokens: 10, outputTokens: 2, llmCalls: 1 });
  });
  it('flat exports without ids behave exactly like main', () => {
    const flat = [{ attributes: { 'gen_ai.usage.input_tokens': 1 } }, { attributes: { 'gen_ai.usage.input_tokens': 2 } }];
    expect(sumUsage(flat).inputTokens).toBe(3);
  });
  it('is cycle-safe on malformed parent links', () => {
    const cyc = [
      { spanId: 'a', parentSpanId: 'b', attributes: { 'gen_ai.usage.input_tokens': 1 } },
      { spanId: 'b', parentSpanId: 'a', attributes: { 'gen_ai.usage.input_tokens': 1 } },
    ];
    expect(() => sumUsage(cyc)).not.toThrow();
  });
  it('model-bearing spans with no usage anywhere still count as calls (legacy)', () => {
    const tree = [span({ spanId: 'a', model: 'm' }), span({ spanId: 'b', parentSpanId: 'a', model: 'm' })];
    expect(metrics(tree).llmCalls).toBe(2);
    expect(selectUsageSpans(tree).counted).toEqual([]);
  });
});
