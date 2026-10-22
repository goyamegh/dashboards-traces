/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token-usage attribution over a span tree.
 *
 * Some agent frameworks (Strands is the measured case) stamp `gen_ai.usage.*`
 * on each per-call `chat` span AND the aggregate on the parent `invoke_agent`
 * span. Summing every span then reports 2× tokens and 2× cost. Other
 * instrumentation reports independent usage on nested spans (a planner model
 * call under an agent span that itself called a model) — there, both counts
 * are real and must both be summed.
 *
 * The rule is therefore CONSERVATIVE: a parent's usage is treated as a
 * roll-up (and dropped in favour of its descendants) ONLY when it is
 * identifiably an aggregate —
 *   (a) its input AND output totals each equal the sum of its usage-bearing
 *       descendants (the Strands shape, measured: 21476/843 == Σ chat), or
 *   (b) it is a GenAI agent-invocation span (`gen_ai.operation.name` =
 *       `invoke_agent` / `create_agent`) whose usage-bearing descendants are
 *       all LLM-call spans (`chat`, `text_completion`, `generate_content`,
 *       `embeddings`) and whose totals are ≥ the descendants' sum per
 *       dimension — the semconv-defined aggregate for an agent invocation
 *       whose children only partially report usage.
 * Anything else — independent nested usage, flat exports without ids — is
 * summed as before. LLM calls are counted separately from token selection:
 * every model-bearing span counts EXCEPT a parent dropped as a roll-up.
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

const AGENT_OPS = new Set(['invoke_agent', 'create_agent']);
const LLM_OPS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);
const opOf = (s: UsageSpanLike): string | undefined => {
  const v = s.attributes?.['gen_ai.operation.name'];
  return typeof v === 'string' ? v : undefined;
};

export interface UsageSelection<T> {
  /** Spans whose usage is summed. */
  counted: T[];
  /** Parents dropped because their usage was identified as a roll-up of `counted` descendants. */
  rolledUp: T[];
}

/**
 * Decide which spans' `gen_ai.usage.*` to sum. See the module comment for the
 * roll-up criteria. Cycle-safe; spans whose parent is not in the list are roots.
 */
export function selectUsageSpans<T extends UsageSpanLike>(spans: T[]): UsageSelection<T> {
  const byId = new Map<string, T>();
  for (const s of spans) if (s.spanId) byId.set(s.spanId, s);
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of spans) {
    if (s.parentSpanId && s.parentSpanId !== s.spanId && byId.has(s.parentSpanId)) {
      const list = children.get(s.parentSpanId) ?? [];
      list.push(s);
      children.set(s.parentSpanId, list);
    } else {
      roots.push(s);
    }
  }

  const counted: T[] = [];
  const rolledUp: T[] = [];
  const visiting = new Set<string>();

  /** Returns the usage-bearing spans counted within this subtree. */
  const collect = (node: T): T[] => {
    if (node.spanId) {
      if (visiting.has(node.spanId)) return [];
      visiting.add(node.spanId);
    }
    const fromChildren: T[] = [];
    for (const c of node.spanId ? children.get(node.spanId) ?? [] : []) fromChildren.push(...collect(c));
    if (!hasUsage(node.attributes)) return fromChildren;
    if (fromChildren.length === 0) return [node];

    const inSum = fromChildren.reduce((n, c) => n + readInputTokens(c.attributes), 0);
    const outSum = fromChildren.reduce((n, c) => n + readOutputTokens(c.attributes), 0);
    const inP = readInputTokens(node.attributes);
    const outP = readOutputTokens(node.attributes);
    const equalRollUp = inP === inSum && outP === outSum;
    const agentRollUp =
      AGENT_OPS.has(opOf(node) ?? '') &&
      fromChildren.every((c) => LLM_OPS.has(opOf(c) ?? '')) &&
      inP >= inSum && outP >= outSum;
    if (equalRollUp || agentRollUp) {
      rolledUp.push(node);
      return fromChildren;
    }
    // Independent nested usage: both the parent and its descendants are real.
    return [node, ...fromChildren];
  };

  for (const r of roots) counted.push(...collect(r));
  return { counted, rolledUp };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of spans whose usage was counted. */
  countedSpans: number;
}

/** Sum token usage over a span list using {@link selectUsageSpans}. */
export function sumUsage<T extends UsageSpanLike>(spans: T[]): UsageTotals & UsageSelection<T> {
  const { counted, rolledUp } = selectUsageSpans(spans);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of counted) {
    inputTokens += readInputTokens(s.attributes);
    outputTokens += readOutputTokens(s.attributes);
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, countedSpans: counted.length, counted, rolledUp };
}
