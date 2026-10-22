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
 * disagrees with the sum of its usage-bearing descendants, the descendants win
 * — they are the per-call ground truth for cost.
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
 * Select the spans whose `gen_ai.usage.*` should be summed: usage-bearing
 * spans with no usage-bearing descendant. Spans without ids are treated as
 * leaves (flat exports with no tree information behave as before).
 */
export function selectUsageSpans<T extends UsageSpanLike>(spans: T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of spans) if (s.spanId) byId.set(s.spanId, s);

  const hasUsageDescendant = new Set<string>();
  for (const s of spans) {
    if (!hasUsage(s.attributes)) continue;
    // Walk up and mark every ancestor; stop at a cycle or an unknown parent.
    const seen = new Set<string>();
    let parentId = s.parentSpanId;
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      hasUsageDescendant.add(parentId);
      parentId = byId.get(parentId)!.parentSpanId;
    }
  }

  return spans.filter((s) => hasUsage(s.attributes) && !(s.spanId && hasUsageDescendant.has(s.spanId)));
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
