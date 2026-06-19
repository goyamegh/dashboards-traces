/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Overview — fleet/agent-level aggregation over correlated spans.
 *
 * This powers the "supercharged when OpenSearch is enabled" overview: instead of
 * per-run metrics, it summarizes an agent's behaviour across sessions in a time
 * window (sessions, LLM calls, tool calls, permission prompts, tokens, cost,
 * models). The file backend deliberately doesn't implement it (see
 * IMetricsOperations) — this is an OpenSearch capability that promotes
 * graduating to an observability cluster.
 *
 * Vendor instrumentation diverges from the OpenTelemetry Gen AI semantic
 * conventions (e.g. Claude Code emits `input_tokens` / `cache_read_tokens`, not
 * `gen_ai.usage.*`; agents tag runIds on `gen_ai.request.id` rather than a
 * namespaced key). `readMetricAttrs` normalizes those variants to one canonical
 * shape so any agent's tokens/cost/model render without per-agent special-casing.
 */

import type { Span, AgentOverview, ServiceOverview } from '../../types/index.js';
import { getPricing } from './metricsService.js';

/** Canonical per-span metric facts, normalized across vendor attribute variants. */
export interface NormalizedSpanMetrics {
  service: string;
  sessionId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolName?: string;
  isLlm: boolean;
  isTool: boolean;
  isBlockedOnUser: boolean;
  isError: boolean;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map a normalized span's attributes onto canonical metric facts, accepting both
 * OTEL semconv keys and common vendor variants (Anthropic/Claude Code, Strands).
 */
export function readMetricAttrs(span: Span): NormalizedSpanMetrics {
  const a: Record<string, any> = (span.attributes as any) || {};
  const name = (span.name || '').toLowerCase();
  const op = a['gen_ai.operation.name'];

  const model = a['gen_ai.request.model'] ?? a['gen_ai.response.model'] ?? a['model'];
  const toolName = a['gen_ai.tool.name'] ?? a['tool_name'] ?? a['tool.name'];

  const inputTokens = num(a['gen_ai.usage.input_tokens'] ?? a['input_tokens'] ?? a['gen_ai.usage.prompt_tokens']);
  const outputTokens = num(a['gen_ai.usage.output_tokens'] ?? a['output_tokens'] ?? a['gen_ai.usage.completion_tokens']);
  const cacheReadTokens = num(a['gen_ai.usage.cache_read.input_tokens'] ?? a['cache_read_tokens']);
  const cacheCreationTokens = num(a['gen_ai.usage.cache_creation.input_tokens'] ?? a['cache_creation_tokens']);

  const isLlm =
    op === 'chat' || op === 'text_completion' ||
    name.includes('llm_request') || name.includes('invoke_model') ||
    (!!model && (inputTokens > 0 || outputTokens > 0 || name.includes('chat') || name.includes('llm')));
  const isTool = op === 'execute_tool' || name === 'claude_code.tool.execution' || name.includes('execute_tool') || (!isLlm && name.includes('tool') && !name.includes('blocked'));
  const isBlockedOnUser = name.includes('blocked_on_user');
  const isError = (span.status as any) === 'ERROR' || a['error'] === true || a['success'] === false;

  return {
    service: a['service.name'] ?? a['serviceName'] ?? 'unknown',
    sessionId: a['gen_ai.conversation.id'] ?? a['session.id'],
    model,
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    toolName,
    isLlm, isTool, isBlockedOnUser, isError,
  };
}

function emptyService(service: string): ServiceOverview {
  return {
    service, sessions: 0, spans: 0, traces: 0, llmCalls: 0, toolCalls: 0,
    blockedOnUser: 0, errors: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, estCostUsd: 0, models: [], topTools: [],
  };
}

/**
 * Rough cost estimate. Uncached in/out priced per the model table; cache reads
 * are ~10% of input price and cache writes ~25% above input price (Anthropic
 * prompt-caching ballpark) — labelled an estimate, not billing truth.
 */
function estimateCost(m: { model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  const p = getPricing(m.model);
  return (
    (m.inputTokens / 1e6) * p.input +
    (m.outputTokens / 1e6) * p.output +
    (m.cacheReadTokens / 1e6) * p.input * 0.1 +
    (m.cacheCreationTokens / 1e6) * p.input * 1.25
  );
}

/**
 * Aggregate a set of (normalized) spans into a per-service agent overview.
 * Pure — no I/O — so it's trivially unit-testable.
 */
export function computeAgentOverview(
  spans: Span[],
  window: { startTime: number; endTime: number },
  opts: { capped?: boolean } = {}
): AgentOverview {
  const bySvc = new Map<string, ServiceOverview>();
  const sessionsBySvc = new Map<string, Set<string>>();
  const tracesBySvc = new Map<string, Set<string>>();
  const modelsBySvc = new Map<string, Set<string>>();
  const toolsBySvc = new Map<string, Map<string, number>>();

  for (const s of spans) {
    const m = readMetricAttrs(s);
    const svc = m.service;
    const o = bySvc.get(svc) || emptyService(svc);
    if (!bySvc.has(svc)) {
      bySvc.set(svc, o);
      sessionsBySvc.set(svc, new Set());
      tracesBySvc.set(svc, new Set());
      modelsBySvc.set(svc, new Set());
      toolsBySvc.set(svc, new Map());
    }
    o.spans++;
    if (s.traceId) tracesBySvc.get(svc)!.add(s.traceId);
    if (m.sessionId) sessionsBySvc.get(svc)!.add(m.sessionId);
    if (m.model) modelsBySvc.get(svc)!.add(m.model);
    if (m.isLlm) o.llmCalls++;
    if (m.isTool) {
      o.toolCalls++;
      if (m.toolName) {
        const tm = toolsBySvc.get(svc)!;
        tm.set(m.toolName, (tm.get(m.toolName) || 0) + 1);
      }
    }
    if (m.isBlockedOnUser) o.blockedOnUser++;
    if (m.isError) o.errors++;
    o.inputTokens += m.inputTokens;
    o.outputTokens += m.outputTokens;
    o.cacheReadTokens += m.cacheReadTokens;
    o.cacheCreationTokens += m.cacheCreationTokens;
  }

  const services: ServiceOverview[] = [];
  for (const [svc, o] of bySvc) {
    o.sessions = sessionsBySvc.get(svc)!.size;
    o.traces = tracesBySvc.get(svc)!.size;
    o.models = Array.from(modelsBySvc.get(svc)!).sort();
    o.topTools = Array.from(toolsBySvc.get(svc)!.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    o.estCostUsd = estimateCost({ model: o.models[0], ...o });
    services.push(o);
  }
  services.sort((a, b) => b.spans - a.spans);

  const totals = services.reduce(
    (t, s) => {
      t.sessions += s.sessions; t.spans += s.spans; t.traces += s.traces;
      t.llmCalls += s.llmCalls; t.toolCalls += s.toolCalls; t.blockedOnUser += s.blockedOnUser;
      t.errors += s.errors; t.inputTokens += s.inputTokens; t.outputTokens += s.outputTokens;
      t.cacheReadTokens += s.cacheReadTokens; t.cacheCreationTokens += s.cacheCreationTokens;
      t.estCostUsd += s.estCostUsd; t.services++;
      return t;
    },
    { sessions: 0, spans: 0, traces: 0, llmCalls: 0, toolCalls: 0, blockedOnUser: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estCostUsd: 0, services: 0 }
  );

  return { window, sampledSpans: spans.length, capped: !!opts.capped, services, totals };
}
