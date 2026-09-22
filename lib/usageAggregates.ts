/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf-usage invariant for token accounting.
 *
 * Some frameworks stamp `gen_ai.usage.*` on an AGGREGATE span (e.g. an
 * `invoke_agent` span whose usage equals the sum of its `chat` children) as
 * well as on the individual LLM-call spans. Summing every span that carries
 * usage then counts those tokens twice. The rule shared by every token reader:
 *
 *   A span's usage counts only if NO descendant span (same trace, via the
 *   parentSpanId chain) also carries usage. When a parent and its descendants
 *   both carry usage, the descendants (leaves) are counted and the parent is
 *   skipped as a roll-up.
 *
 * A parent that carries usage while none of its descendants do is still
 * counted (it is the only record of that work).
 */

export interface UsageSpanLike {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

function nodeKey(traceId: string | undefined, spanId: string): string {
  return `${traceId ?? ''}:${spanId}`;
}

/**
 * Return the spans whose usage must be SKIPPED because at least one
 * descendant also carries usage. `hasUsage` decides which spans carry usage
 * (readers differ in the attribute keys they accept).
 *
 * Spans without a `spanId` can never be identified as an ancestor and are
 * never skipped. Cycles / missing parents terminate the ancestor walk.
 */
export function findUsageAggregateSpans<T extends UsageSpanLike>(
  spans: readonly T[],
  hasUsage: (span: T) => boolean,
): Set<T> {
  const byKey = new Map<string, T>();
  for (const span of spans) {
    if (span.spanId) byKey.set(nodeKey(span.traceId, span.spanId), span);
  }

  const aggregates = new Set<T>();
  for (const span of spans) {
    if (!hasUsage(span)) continue;
    // Walk up: every usage-carrying ancestor of a usage-carrying span is a roll-up.
    const visited = new Set<string>();
    let parentId = span.parentSpanId;
    while (parentId) {
      const key = nodeKey(span.traceId, parentId);
      if (visited.has(key)) break;
      visited.add(key);
      const parent = byKey.get(key);
      if (!parent) break;
      if (hasUsage(parent)) aggregates.add(parent);
      parentId = parent.parentSpanId;
    }
  }
  return aggregates;
}
