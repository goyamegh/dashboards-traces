/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { findUsageAggregateSpans } from '@/lib/usageAggregates';

interface S { traceId?: string; spanId?: string; parentSpanId?: string; usage?: number }

const hasUsage = (s: S) => (s.usage ?? 0) > 0;
const span = (spanId: string, parentSpanId?: string, usage?: number, traceId = 't1'): S =>
  ({ traceId, spanId, parentSpanId, usage });

describe('findUsageAggregateSpans', () => {
  it('skips a parent whose children also carry usage (roll-up)', () => {
    const parent = span('agent', undefined, 300);
    const c1 = span('chat1', 'agent', 100);
    const c2 = span('chat2', 'agent', 200);
    const skipped = findUsageAggregateSpans([parent, c1, c2], hasUsage);
    expect(skipped.has(parent)).toBe(true);
    expect(skipped.has(c1)).toBe(false);
    expect(skipped.has(c2)).toBe(false);
  });

  it('counts a parent that carries usage while no descendant does', () => {
    const parent = span('agent', undefined, 300);
    const tool = span('tool', 'agent');
    expect(findUsageAggregateSpans([parent, tool], hasUsage).size).toBe(0);
  });

  it('children-only trees are untouched', () => {
    const parent = span('agent');
    const c1 = span('chat1', 'agent', 100);
    expect(findUsageAggregateSpans([parent, c1], hasUsage).size).toBe(0);
  });

  it('skips every usage-carrying ancestor, not just the direct parent', () => {
    const root = span('root', undefined, 500);       // aggregate
    const cycle = span('cycle', 'root');             // no usage, passthrough
    const wrap = span('wrap', 'cycle', 500);         // aggregate
    const chat = span('chat', 'wrap', 500);          // leaf
    const skipped = findUsageAggregateSpans([root, cycle, wrap, chat], hasUsage);
    expect([...skipped]).toEqual(expect.arrayContaining([root, wrap]));
    expect(skipped.size).toBe(2);
  });

  it('mixed tree: aggregate in one branch, lone usage in another', () => {
    const root = span('root');
    const a = span('a', 'root', 30);        // aggregate of a1
    const a1 = span('a1', 'a', 30);
    const b = span('b', 'root', 70);        // only usage in its branch → counted
    const b1 = span('b1', 'b');
    const skipped = findUsageAggregateSpans([root, a, a1, b, b1], hasUsage);
    expect(skipped.has(a)).toBe(true);
    expect(skipped.has(b)).toBe(false);
    expect(skipped.size).toBe(1);
  });

  it('does not link spans across traces even when span ids collide', () => {
    const parent = span('p', undefined, 10, 'trace-A');
    const child = span('c', 'p', 10, 'trace-B');
    expect(findUsageAggregateSpans([parent, child], hasUsage).size).toBe(0);
  });

  it('tolerates orphans, missing ids and cycles', () => {
    const orphan = span('o', 'missing', 10);
    const noId: S = { traceId: 't1', usage: 5 };
    const x = span('x', 'y', 1);
    const y = span('y', 'x', 1);
    const skipped = findUsageAggregateSpans([orphan, noId, x, y], hasUsage);
    // x and y are each other's "ancestor" — both carry usage, both flagged; no infinite loop.
    expect(skipped.has(x)).toBe(true);
    expect(skipped.has(y)).toBe(true);
    expect(skipped.has(orphan)).toBe(false);
    expect(skipped.has(noId)).toBe(false);
  });
});
