/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token-usage attribution over a span tree.
 *
 * Agent frameworks that roll usage up (Strands, LangGraph, ADK, …) stamp
 * `gen_ai.usage.*` on BOTH the per-call `chat` spans and the parent
 * `invoke_agent` span (whose numbers are the sum of its children). Summing
 * every span then reports 2× tokens and 2× cost. The rule here is
 * structural rather than name-based so it holds for any framework:
 *
 *   a span's usage counts only if no descendant span carries usage.
 *
 * A root that reports usage with no instrumented children (agents that only
 * instrument the top-level call) is still counted. When a parent's aggregate
 * is smaller than or equal to the sum of its usage-bearing descendants, the
 * descendants win (per-call ground truth); when it is larger, the children
 * are only partially instrumented and the parent is counted instead.
 */

export interface UsageSpanLike {
  spanId?: string;
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Input tokens, accepting the pre-rename `prompt_tokens` alias. */
export function readInputTokens(attrs: Record<string, unknown> | undefined): number {
  const a = attrs || {};
  return num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['input_tokens']);
}

/** Output tokens, accepting the pre-rename `completion_tokens` alias. */
export function readOutputTokens(attrs: Record<string, unknown> | undefined): number {
  const a = attrs || {};
  return num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['output_tokens']);
}

export function hasUsage(attrs: Record<string, unknown> | undefined): boolean {
  return readInputTokens(attrs) > 0 || readOutputTokens(attrs) > 0;
}

/**
 * Select the spans whose `gen_ai.usage.*` should be summed.
 *
 * Per subtree: if a usage-bearing span has usage-bearing descendants, the
 * descendants are counted instead of the span — unless the span's own total
 * is LARGER than what its counted descendants add up to, in which case the
 * span is the more complete record (children only partially instrumented)
 * and it is counted alone. A roll-up equal to its children (Strands) and a
 * root that is the only instrumented span both resolve correctly. Spans
 * without ids are treated as leaves (flat exports behave as before).
 */
export function selectUsageSpans<T extends UsageSpanLike>(spans: T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of spans) if (s.spanId) byId.set(s.spanId, s);
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId) && s.parentSpanId !== s.spanId) {
      const list = children.get(s.parentSpanId) ?? [];
      list.push(s);
      children.set(s.parentSpanId, list);
    } else {
      roots.push(s);
    }
  }

  const total = (s: T): number => readInputTokens(s.attributes) + readOutputTokens(s.attributes);
  const out: T[] = [];
  const visiting = new Set<string>();

  /** Returns the spans counted within this subtree (cycle-safe). */
  const collect = (node: T): T[] => {
    if (node.spanId) {
      if (visiting.has(node.spanId)) return [];
      visiting.add(node.spanId);
    }
    const fromChildren: T[] = [];
    for (const c of node.spanId ? children.get(node.spanId) ?? [] : []) fromChildren.push(...collect(c));
    if (!hasUsage(node.attributes)) return fromChildren;
    if (fromChildren.length === 0) return [node];
    const childSum = fromChildren.reduce((n, c) => n + total(c), 0);
    return total(node) > childSum ? [node] : fromChildren;
  };

  for (const r of roots) out.push(...collect(r));
  return out;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of spans whose usage was counted (≈ LLM calls). */
  countedSpans: number;
}

/** Sum token usage over a span list using {@link selectUsageSpans}. */
export function sumUsage<T extends UsageSpanLike>(spans: T[]): UsageTotals & { counted: T[] } {
  const counted = selectUsageSpans(spans);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of counted) {
    inputTokens += readInputTokens(s.attributes);
    outputTokens += readOutputTokens(s.attributes);
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, countedSpans: counted.length, counted };
}
