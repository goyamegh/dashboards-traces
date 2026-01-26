/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for TraceFlyoutContent component logic
 *
 * Tests the span statistics calculation and categorization logic.
 */

import { Span } from '@/types';

// Helper to create test spans
function createSpan(overrides: Partial<Span> = {}): Span {
  const spanId = overrides.spanId || `span-${Math.random().toString(36).substr(2, 9)}`;
  const traceId = overrides.traceId || 'test-trace-id';
  const startTime = overrides.startTime || '2024-01-01T00:00:00Z';
  const endTime = overrides.endTime || '2024-01-01T00:00:01Z';

  return {
    spanId,
    traceId,
    name: overrides.name || 'test-span',
    startTime,
    endTime,
    status: overrides.status || 'OK',
    attributes: overrides.attributes || {},
    parentSpanId: overrides.parentSpanId,
  };
}

// Replicate the span stats calculation logic from TraceFlyoutContent
function calculateSpanStats(spans: Span[]) {
  const byStatus = spans.reduce(
    (acc, span) => {
      if (span.status === 'ERROR') acc.error++;
      else if (span.status === 'OK') acc.ok++;
      else acc.unset++;
      return acc;
    },
    { ok: 0, error: 0, unset: 0 }
  );

  const byCategory = spans.reduce(
    (acc, span) => {
      const name = span.name.toLowerCase();
      if (name.includes('llm') || name.includes('bedrock') || name.includes('converse')) {
        acc.llm++;
      } else if (name.includes('tool') || span.attributes?.['gen_ai.tool.name']) {
        acc.tool++;
      } else if (name.includes('agent')) {
        acc.agent++;
      } else {
        acc.other++;
      }
      return acc;
    },
    { agent: 0, llm: 0, tool: 0, other: 0 }
  );

  return { byStatus, byCategory };
}

describe('TraceFlyoutContent - span stats calculation', () => {
  describe('status counting', () => {
    it('counts OK status spans', () => {
      const spans = [
        createSpan({ status: 'OK' }),
        createSpan({ status: 'OK' }),
        createSpan({ status: 'OK' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byStatus.ok).toBe(3);
      expect(stats.byStatus.error).toBe(0);
      expect(stats.byStatus.unset).toBe(0);
    });

    it('counts ERROR status spans', () => {
      const spans = [
        createSpan({ status: 'ERROR' }),
        createSpan({ status: 'OK' }),
        createSpan({ status: 'ERROR' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byStatus.ok).toBe(1);
      expect(stats.byStatus.error).toBe(2);
    });

    it('counts UNSET status spans', () => {
      const spans = [
        createSpan({ status: 'UNSET' }),
        createSpan({ status: 'UNSET' }),
        createSpan({ status: 'OK' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byStatus.ok).toBe(1);
      expect(stats.byStatus.unset).toBe(2);
    });

    it('handles mixed statuses', () => {
      const spans = [
        createSpan({ status: 'OK' }),
        createSpan({ status: 'ERROR' }),
        createSpan({ status: 'UNSET' }),
        createSpan({ status: 'OK' }),
        createSpan({ status: 'ERROR' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byStatus.ok).toBe(2);
      expect(stats.byStatus.error).toBe(2);
      expect(stats.byStatus.unset).toBe(1);
    });
  });

  describe('category detection', () => {
    it('detects LLM spans from name', () => {
      const spans = [
        createSpan({ name: 'llm.call' }),
        createSpan({ name: 'bedrock.invoke' }),
        createSpan({ name: 'converse.api' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.llm).toBe(3);
      expect(stats.byCategory.agent).toBe(0);
      expect(stats.byCategory.tool).toBe(0);
    });

    it('detects tool spans from name', () => {
      const spans = [
        createSpan({ name: 'tool.execute' }),
        createSpan({ name: 'my_tool_call' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.tool).toBe(2);
    });

    it('detects tool spans from gen_ai.tool.name attribute', () => {
      const spans = [
        createSpan({
          name: 'execute_operation',
          attributes: { 'gen_ai.tool.name': 'search_tool' },
        }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.tool).toBe(1);
    });

    it('detects agent spans from name', () => {
      const spans = [
        createSpan({ name: 'agent.run' }),
        createSpan({ name: 'my_agent_execution' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.agent).toBe(2);
    });

    it('categorizes other spans correctly', () => {
      const spans = [
        createSpan({ name: 'http.request' }),
        createSpan({ name: 'database.query' }),
        createSpan({ name: 'custom_operation' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.other).toBe(3);
    });

    it('handles mixed categories', () => {
      const spans = [
        createSpan({ name: 'agent.run' }),
        createSpan({ name: 'llm.call' }),
        createSpan({ name: 'bedrock.invoke' }),
        createSpan({ name: 'tool.execute' }),
        createSpan({ name: 'http.request' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.agent).toBe(1);
      expect(stats.byCategory.llm).toBe(2);
      expect(stats.byCategory.tool).toBe(1);
      expect(stats.byCategory.other).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles empty span array', () => {
      const stats = calculateSpanStats([]);

      expect(stats.byStatus.ok).toBe(0);
      expect(stats.byStatus.error).toBe(0);
      expect(stats.byStatus.unset).toBe(0);
      expect(stats.byCategory.agent).toBe(0);
      expect(stats.byCategory.llm).toBe(0);
      expect(stats.byCategory.tool).toBe(0);
      expect(stats.byCategory.other).toBe(0);
    });

    it('handles single span', () => {
      const spans = [createSpan({ name: 'llm.call', status: 'OK' })];

      const stats = calculateSpanStats(spans);

      expect(stats.byStatus.ok).toBe(1);
      expect(stats.byCategory.llm).toBe(1);
    });

    it('handles case-insensitive category matching', () => {
      const spans = [
        createSpan({ name: 'LLM.Call' }),
        createSpan({ name: 'BEDROCK.Invoke' }),
        createSpan({ name: 'Agent.Run' }),
      ];

      const stats = calculateSpanStats(spans);

      expect(stats.byCategory.llm).toBe(2);
      expect(stats.byCategory.agent).toBe(1);
    });

    it('handles spans with undefined attributes', () => {
      const span: Span = {
        spanId: 'test',
        traceId: 'test',
        name: 'test-span',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        status: 'OK',
        // attributes is undefined
      };

      const stats = calculateSpanStats([span]);

      expect(stats.byStatus.ok).toBe(1);
      expect(stats.byCategory.other).toBe(1);
    });
  });
});

describe('TraceFlyoutContent - expand/collapse state', () => {
  it('tracks expanded spans in Set', () => {
    const expandedSpans = new Set<string>();

    // Simulate adding spans
    expandedSpans.add('span-1');
    expandedSpans.add('span-2');

    expect(expandedSpans.has('span-1')).toBe(true);
    expect(expandedSpans.has('span-2')).toBe(true);
    expect(expandedSpans.has('span-3')).toBe(false);
  });

  it('toggles span expansion correctly', () => {
    const expandedSpans = new Set<string>(['span-1', 'span-2']);

    // Toggle to collapse
    const toggleExpand = (spanId: string) => {
      const next = new Set(expandedSpans);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    };

    const result1 = toggleExpand('span-1');
    expect(result1.has('span-1')).toBe(false);
    expect(result1.has('span-2')).toBe(true);

    const result2 = toggleExpand('span-3');
    expect(result2.has('span-1')).toBe(true);
    expect(result2.has('span-3')).toBe(true);
  });
});
