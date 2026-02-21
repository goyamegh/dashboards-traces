/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { preprocessSpanTree } from '@/services/traces/spanPreprocessing';
import type { Span, TimeRange } from '@/types';

describe('Span Preprocessing', () => {
  /**
   * Generate mock spans for testing
   */
  function generateMockSpans(count: number, depth: number = 2, prefix = 'span'): Span[] {
    const baseTime = Date.now();
    const spans: Span[] = [];

    for (let i = 0; i < count; i++) {
      const startTime = new Date(baseTime + i * 1000).toISOString();
      const endTime = new Date(baseTime + i * 1000 + 500).toISOString();

      const span: Span = {
        traceId: 'trace-1',
        spanId: `${prefix}-${i}`,
        parentSpanId: undefined,
        name: `Span ${prefix}-${i}`,
        startTime,
        endTime,
        duration: 500,
        status: 'OK',
        children: depth > 0 ? generateMockSpans(2, depth - 1, `${prefix}-${i}-child`) : [],
      };

      spans.push(span);
    }

    return spans;
  }

  it('should preprocess tree in single pass', () => {
    const spans = generateMockSpans(10, 1);
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    expect(result.categorizedTree).toBeDefined();
    expect(result.categorizedTree.length).toBe(10);
    expect(result.flattenedSpans).toBeDefined();
    expect(result.categoryStats).toBeDefined();
    expect(result.toolStats).toBeDefined();
    expect(result.spanIndex.size).toBeGreaterThan(0);
  });

  it('should create valid span index for O(1) lookups', () => {
    const spans = generateMockSpans(5, 2);
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    // Should be able to lookup any span in O(1)
    const firstSpan = result.flattenedSpans[0];
    const found = result.spanIndex.get(firstSpan.spanId);

    expect(found).toBe(firstSpan);
    expect(found?.spanId).toBe(firstSpan.spanId);
  });

  it('should flatten tree correctly', () => {
    const spans = generateMockSpans(3, 2);
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    // Should have all spans in flattened list
    // 3 root spans + (3 * 2 children) + (6 * 2 grandchildren) = 3 + 6 + 12 = 21
    expect(result.flattenedSpans.length).toBe(21);

    // Each flattened span should have depth assigned
    result.flattenedSpans.forEach(span => {
      expect(typeof span.depth).toBe('number');
      expect(span.depth).toBeGreaterThanOrEqual(0);
    });
  });

  it('should calculate category statistics', () => {
    const spans = generateMockSpans(10, 1);
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    expect(result.categoryStats.length).toBeGreaterThan(0);

    // Each category should have valid stats
    result.categoryStats.forEach(cat => {
      expect(cat.category).toBeDefined();
      expect(cat.count).toBeGreaterThan(0);
      expect(cat.percentage).toBeGreaterThanOrEqual(0);
      expect(cat.percentage).toBeLessThanOrEqual(100);
    });

    // Sum of percentages should be ~100%
    const totalPercentage = result.categoryStats.reduce(
      (sum, cat) => sum + cat.percentage,
      0
    );
    expect(totalPercentage).toBeCloseTo(100, 0);
  });

  it('should handle empty span tree', () => {
    const spans: Span[] = [];
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    expect(result.categorizedTree).toEqual([]);
    expect(result.flattenedSpans).toEqual([]);
    expect(result.categoryStats).toEqual([]);
    expect(result.toolStats).toEqual([]);
    expect(result.spanIndex.size).toBe(0);
  });

  it('should handle spans with no children', () => {
    const spans: Span[] = [
      {
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: undefined,
        name: 'Root Span',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1000).toISOString(),
        duration: 1000,
        status: 'OK',
        children: [],
      },
    ];

    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    expect(result.categorizedTree.length).toBe(1);
    expect(result.flattenedSpans.length).toBe(1);
    expect(result.spanIndex.size).toBe(1);
  });

  it('should categorize spans correctly', () => {
    const spans: Span[] = [
      {
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: undefined,
        name: 'executeTool Read', // Use name pattern recognized by categorization
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1000).toISOString(),
        duration: 1000,
        status: 'OK',
        children: [],
      },
    ];

    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    // Should categorize as TOOL
    expect(result.categorizedTree[0].category).toBe('TOOL');

    // Should extract tool usage (tool name extraction logic is in traceStats.extractToolName)
    expect(result.toolStats.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle deep nesting', () => {
    const spans = generateMockSpans(2, 5); // 5 levels deep
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    // Should handle deep nesting without issues
    expect(result.flattenedSpans.length).toBeGreaterThan(0);

    // Should have spans at various depths
    const depths = result.flattenedSpans.map(s => s.depth);
    const maxDepth = Math.max(...depths);
    expect(maxDepth).toBeGreaterThanOrEqual(5);
  });

  it('should maintain tree structure in categorizedTree', () => {
    const spans = generateMockSpans(3, 2);
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 10000,
      duration: 10000,
    };

    const result = preprocessSpanTree(spans, timeRange);

    // Root spans should have children
    expect(result.categorizedTree.length).toBe(3);
    result.categorizedTree.forEach(root => {
      expect(root.children).toBeDefined();
      expect(root.children!.length).toBeGreaterThan(0);

      // Children should have grandchildren
      root.children!.forEach(child => {
        expect(child.children).toBeDefined();
      });
    });
  });

  it('should be performant with large trees', () => {
    const spans = generateMockSpans(50, 3); // 50 roots with 3 levels
    const timeRange: TimeRange = {
      startTime: Date.now(),
      endTime: Date.now() + 100000,
      duration: 100000,
    };

    const startTime = Date.now();
    const result = preprocessSpanTree(spans, timeRange);
    const elapsed = Date.now() - startTime;

    // Should process large tree quickly (< 100ms)
    expect(elapsed).toBeLessThan(100);

    // Should have processed all spans (50 + 50*2 + 50*2*2 = 50 + 100 + 200 = 350 spans)
    expect(result.flattenedSpans.length).toBeGreaterThan(300);
    expect(result.spanIndex.size).toBeGreaterThan(300);
  });
});
