/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { selectUsageSpans, sumUsage, readInputTokens, readOutputTokens } from '@/services/traces/tokenUsage';
import { computeTraceSummary } from '@/services/traces/traceSummary';
import { computeMetricsFromSpans } from '@/server/services/metricsService';
import { transformSpan } from '@/server/services/tracesService';
import { cloudWatchSpanToSource, type CloudWatchSpanRecord } from '@/server/adapters/observability/cloudwatch/recordMappers';
import { processSpansIntoTree } from '@/services/traces/index';
import type { Span } from '@/types';
import fixture from '../../../fixtures/cloudwatch/aws-spans-trace.json';

const records = fixture as unknown as CloudWatchSpanRecord[];
const sources = records.map(cloudWatchSpanToSource);
const spans = sources.map((s) => transformSpan(s) as unknown as Span);

// The fixture mirrors a real Strands trace: the agent root carries the
// aggregate (21476/843) AND each chat span carries its own call (sum = same).
const CHAT_IN = 5542 + 7470 + 8464; // 21476
const CHAT_OUT = 175 + 325 + 343; // 843

describe('tokenUsage — roll-up aware token attribution', () => {
  it('reads input/output tokens with legacy aliases', () => {
    expect(readInputTokens({ 'gen_ai.usage.input_tokens': 5 })).toBe(5);
    expect(readInputTokens({ 'gen_ai.usage.prompt_tokens': '7' })).toBe(7);
    expect(readOutputTokens({ 'gen_ai.usage.completion_tokens': 3 })).toBe(3);
    expect(readOutputTokens({ 'gen_ai.usage.output_tokens': 'nope' })).toBe(0);
    expect(readInputTokens(undefined)).toBe(0);
  });

  it('selects only usage spans without usage-bearing descendants', () => {
    const selected = selectUsageSpans(spans);
    expect(selected.map((s) => s.name).sort()).toEqual(['chat', 'chat', 'chat']);
    expect(selected.some((s) => s.name.startsWith('invoke_agent'))).toBe(false);
  });

  it('sums exactly the per-call totals (not 2×) for a roll-up trace', () => {
    const totals = sumUsage(spans);
    expect(totals.inputTokens).toBe(CHAT_IN);
    expect(totals.outputTokens).toBe(CHAT_OUT);
    expect(totals.countedSpans).toBe(3);
    // Sanity: the naive sum WOULD be double.
    const naive = spans.reduce((n, s) => n + readInputTokens(s.attributes), 0);
    expect(naive).toBe(2 * CHAT_IN);
  });

  it('still counts a root that reports usage with no instrumented children', () => {
    const only = [{ spanId: 'r', attributes: { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 } }];
    expect(sumUsage(only)).toMatchObject({ inputTokens: 10, outputTokens: 2, countedSpans: 1 });
  });

  it('treats spans without ids as leaves (flat exports keep legacy behaviour)', () => {
    const flat = [
      { attributes: { 'gen_ai.usage.input_tokens': 1 } },
      { attributes: { 'gen_ai.usage.input_tokens': 2 } },
    ];
    expect(sumUsage(flat).inputTokens).toBe(3);
  });

  it('is cycle-safe on malformed parent links', () => {
    const cyc = [
      { spanId: 'a', parentSpanId: 'b', attributes: { 'gen_ai.usage.input_tokens': 1 } },
      { spanId: 'b', parentSpanId: 'a', attributes: { 'gen_ai.usage.input_tokens': 1 } },
    ];
    expect(() => sumUsage(cyc)).not.toThrow();
  });
});

describe('both summers agree and neither double-counts', () => {
  it('computeTraceSummary (client) reports the per-call total', () => {
    const tree = processSpansIntoTree(spans);
    const summary = computeTraceSummary(tree);
    expect(summary.inputTokens).toBe(CHAT_IN);
    expect(summary.outputTokens).toBe(CHAT_OUT);
    expect(summary.totalTokens).toBe(CHAT_IN + CHAT_OUT);
    expect(summary.peakInputTokens).toBe(8464);
    expect(summary.models).toEqual(['demo-provider.demo-model-v1']);
  });

  it('computeMetricsFromSpans (server) reports the per-call total and 3 LLM calls', () => {
    const sorted = [...sources].sort((a, b) => Date.parse(a.startTime!) - Date.parse(b.startTime!));
    const m = computeMetricsFromSpans('cw-run-2', sorted);
    expect(m.inputTokens).toBe(CHAT_IN);
    expect(m.outputTokens).toBe(CHAT_OUT);
    expect(m.totalTokens).toBe(CHAT_IN + CHAT_OUT);
    expect(m.llmCalls).toBe(3);
    expect(m.toolsUsed.sort()).toEqual(['run_query', 'search_docs', 'describe_index']);
    expect(m.traceId).toBe('a54f35c518ca4fe4b86b07f10aeea457');
    expect(m.durationMs).toBeGreaterThan(11_000);
    expect(m.status).toBe('success');
  });
});
