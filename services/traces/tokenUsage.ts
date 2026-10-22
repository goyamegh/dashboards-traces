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
 * Rules, per usage-bearing parent with usage-bearing descendants:
 *   (a) EQUAL roll-up — input AND output each equal Σ descendants: the parent
 *       is a mirror; count the descendants (they are the calls).
 *   (b) AGENT aggregate — `gen_ai.operation.name` is `invoke_agent` /
 *       `create_agent`, every usage-bearing descendant is an LLM-call span
 *       (`chat`, `text_completion`, `generate_content`, `embeddings`) and the
 *       parent's totals cover the descendants per dimension: the parent is the
 *       semconv aggregate for the invocation, so its TOTAL is the truth and
 *       the REMAINDER over the instrumented children (calls that never
 *       reported) is preserved — tokens = parent totals, LLM calls =
 *       descendants + 1 when a remainder exists.
 *   (c) anything else (independent nested usage, a plain parent that merely
 *       exceeds its children, flat exports without ids): SUM every span —
 *       exactly what main does today.
 * LLM calls are counted independently of token selection: every model-bearing
 * span, except a parent dropped under (a) and except children folded into a
 * (b) aggregate are replaced by "descendants + remainder".
 *
 * Known ambiguity (why this ships as its own change): an `invoke_agent` span
 * reporting 100/20 over a single `chat` child reporting 50/10 is read as a
 * partially-instrumented aggregate (100/20, 2 calls) under (b); if the
 * framework in fact meant two independent calls the truth is 150/30. Only
 * framework knowledge can tell them apart; (b) is the semconv reading.
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
  /** Spans whose usage is summed as-is. */
  counted: T[];
  /** Parents dropped because their usage equals Σ counted descendants (rule a). */
  rolledUp: T[];
  /**
   * Agent aggregates kept as the subtree's total (rule b): the parent's
   * totals are summed INSTEAD of its descendants'; `remainderCalls` is 1 when
   * the parent reports more than its instrumented children.
   */
  aggregates: Array<{ parent: T; descendants: T[]; remainderCalls: 0 | 1 }>;
}

/**
 * Decide which spans' `gen_ai.usage.*` to sum. See the module comment for the
 * rules. Cycle-safe; spans whose parent is not in the list are roots.
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
  const aggregates: UsageSelection<T>['aggregates'] = [];
  const visiting = new Set<string>();

  /** Usage-bearing spans that represent this subtree (after folding). */
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
    if (inP === inSum && outP === outSum) {
      rolledUp.push(node); // (a) mirror of its children
      return fromChildren;
    }
    const agentAggregate =
      AGENT_OPS.has(opOf(node) ?? '') &&
      fromChildren.every((c) => LLM_OPS.has(opOf(c) ?? '')) &&
      inP >= inSum && outP >= outSum;
    if (agentAggregate) {
      // (b) the parent's total is the truth; descendants are folded into it.
      aggregates.push({ parent: node, descendants: fromChildren, remainderCalls: inP > inSum || outP > outSum ? 1 : 0 });
      return [node];
    }
    return [node, ...fromChildren]; // (c) independent nested usage
  };

  for (const r of roots) counted.push(...collect(r));
  return { counted, rolledUp, aggregates };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** LLM calls: counted model/usage spans, with folded aggregates expanded to descendants (+1 for a remainder). */
  llmCalls: number;
}

/** Sum token usage over a span list using {@link selectUsageSpans}. */
export function sumUsage<T extends UsageSpanLike>(spans: T[]): UsageTotals & UsageSelection<T> {
  const sel = selectUsageSpans(spans);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of sel.counted) {
    inputTokens += readInputTokens(s.attributes);
    outputTokens += readOutputTokens(s.attributes);
  }
  const aggregateParents = new Set(sel.aggregates.map((a) => a.parent));
  let llmCalls = sel.counted.filter((s) => !aggregateParents.has(s)).length;
  for (const a of sel.aggregates) llmCalls += a.descendants.length + a.remainderCalls;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, llmCalls, ...sel };
}
