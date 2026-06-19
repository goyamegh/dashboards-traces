/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeAgentOverview, readMetricAttrs } from '@/server/services/agentOverview';
import type { Span } from '@/types';

function span(name: string, attributes: Record<string, any>, extra: Partial<Span> = {}): Span {
  return {
    traceId: 't1', spanId: 's' + Math.random().toString(36).slice(2, 7), parentSpanId: '',
    name, startTime: '2026-06-17T09:00:00Z', endTime: '2026-06-17T09:00:01Z',
    duration: 1000, status: 'OK', attributes, events: [],
    ...extra,
  } as any;
}

describe('readMetricAttrs (vendor normalization)', () => {
  it('reads Claude Code vendor token keys (input_tokens / cache_read_tokens), not just semconv', () => {
    const m = readMetricAttrs(span('claude_code.llm_request', {
      'service.name': 'claude-code-agent', 'session.id': 'sess-1', model: 'claude-opus-4',
      input_tokens: 2, output_tokens: 348, cache_read_tokens: 238471, cache_creation_tokens: 669,
    }));
    expect(m.service).toBe('claude-code-agent');
    expect(m.sessionId).toBe('sess-1');
    expect(m.model).toBe('claude-opus-4');
    expect(m.inputTokens).toBe(2);
    expect(m.outputTokens).toBe(348);
    expect(m.cacheReadTokens).toBe(238471);
    expect(m.cacheCreationTokens).toBe(669);
    expect(m.isLlm).toBe(true);
  });

  it('reads OTEL semconv token keys when present', () => {
    const m = readMetricAttrs(span('chat', {
      'service.name': 'svc', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'nova-pro',
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300,
      'gen_ai.conversation.id': 'conv-9',
    }));
    expect(m.inputTokens).toBe(1200);
    expect(m.outputTokens).toBe(300);
    expect(m.sessionId).toBe('conv-9');
    expect(m.isLlm).toBe(true);
  });

  it('classifies tool execution and permission prompts', () => {
    expect(readMetricAttrs(span('claude_code.tool.execution', { 'service.name': 's', tool_name: 'Bash' })).isTool).toBe(true);
    expect(readMetricAttrs(span('claude_code.tool.execution', { 'service.name': 's', tool_name: 'Bash' })).toolName).toBe('Bash');
    expect(readMetricAttrs(span('claude_code.tool.blocked_on_user', { 'service.name': 's' })).isBlockedOnUser).toBe(true);
    expect(readMetricAttrs(span('execute_tool search', { 'service.name': 's', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' })).isTool).toBe(true);
  });

  it('flags errors from status / success', () => {
    expect(readMetricAttrs(span('x', { 'service.name': 's' }, { status: 'ERROR' as any })).isError).toBe(true);
    expect(readMetricAttrs(span('x', { 'service.name': 's', success: false })).isError).toBe(true);
  });
});

describe('computeAgentOverview', () => {
  const window = { startTime: 1, endTime: 2 };

  it('aggregates per service: sessions, llm/tool counts, prompts, tokens', () => {
    const spans: Span[] = [
      span('claude_code.interaction', { 'service.name': 'claude-code-agent', 'session.id': 'a' }, { traceId: 'tA' }),
      span('claude_code.llm_request', { 'service.name': 'claude-code-agent', 'session.id': 'a', model: 'opus', input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000 }, { traceId: 'tA' }),
      span('claude_code.llm_request', { 'service.name': 'claude-code-agent', 'session.id': 'b', model: 'opus', input_tokens: 200, output_tokens: 80 }, { traceId: 'tB' }),
      span('claude_code.tool.execution', { 'service.name': 'claude-code-agent', 'session.id': 'a', tool_name: 'Bash' }, { traceId: 'tA' }),
      span('claude_code.tool.execution', { 'service.name': 'claude-code-agent', 'session.id': 'a', tool_name: 'Bash' }, { traceId: 'tA' }),
      span('claude_code.tool.blocked_on_user', { 'service.name': 'claude-code-agent', 'session.id': 'a' }, { traceId: 'tA' }),
      // a second service
      span('test_case', { 'service.name': 'agent-health' }, { traceId: 'tE' }),
    ];

    const ov = computeAgentOverview(spans, window, { capped: false });

    expect(ov.services).toHaveLength(2);
    const cc = ov.services.find(s => s.service === 'claude-code-agent')!;
    expect(cc.sessions).toBe(2);          // a, b
    expect(cc.traces).toBe(2);            // tA, tB
    expect(cc.llmCalls).toBe(2);
    expect(cc.toolCalls).toBe(2);
    expect(cc.blockedOnUser).toBe(1);
    expect(cc.inputTokens).toBe(300);
    expect(cc.outputTokens).toBe(130);
    expect(cc.cacheReadTokens).toBe(1000);
    expect(cc.models).toEqual(['opus']);
    expect(cc.topTools).toEqual([{ name: 'Bash', count: 2 }]);
    expect(cc.estCostUsd).toBeGreaterThan(0);

    // totals roll up across services
    expect(ov.totals.services).toBe(2);
    expect(ov.totals.llmCalls).toBe(2);
    expect(ov.totals.spans).toBe(7);
    expect(ov.sampledSpans).toBe(7);
    expect(ov.capped).toBe(false);
  });

  it('returns empty services for no spans', () => {
    const ov = computeAgentOverview([], window);
    expect(ov.services).toEqual([]);
    expect(ov.totals.spans).toBe(0);
  });

  it('propagates the capped flag', () => {
    expect(computeAgentOverview([], window, { capped: true }).capped).toBe(true);
  });
});
