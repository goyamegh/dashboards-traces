/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for Sample Traces module
 */

import {
  SAMPLE_TRACE_SPANS,
  getSampleSpansForRunId,
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  getAllSampleTraceSpansWithRecentTimestamps,
  isSampleTraceId,
  getSampleTraceIds,
} from '@/cli/demo/sampleTraces';

describe('Sample Traces', () => {
  describe('SAMPLE_TRACE_SPANS', () => {
    it('should have multiple trace spans', () => {
      expect(SAMPLE_TRACE_SPANS.length).toBeGreaterThan(0);
    });

    it('should have demo- prefix for all trace IDs', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.traceId).toMatch(/^demo-trace-/);
      });
    });

    it('should have required span fields', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.traceId).toBeDefined();
        expect(span.spanId).toBeDefined();
        expect(span.name).toBeDefined();
        expect(span.startTime).toBeDefined();
        expect(span.endTime).toBeDefined();
        expect(span.duration).toBeDefined();
        expect(span.status).toBeDefined();
        expect(span.attributes).toBeDefined();
      });
    });

    it('should have valid ISO timestamps', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(() => new Date(span.startTime)).not.toThrow();
        expect(() => new Date(span.endTime)).not.toThrow();
      });
    });

    it('should have positive durations', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.duration).toBeGreaterThan(0);
      });
    });
  });

  describe('getSampleSpansForRunId', () => {
    it('should return spans for specific run ID', () => {
      const spans = getSampleSpansForRunId('demo-agent-run-001');
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.attributes['run.id']).toBe('demo-agent-run-001');
      });
    });

    it('should return empty array for unknown run ID', () => {
      const spans = getSampleSpansForRunId('unknown-run');
      expect(spans).toEqual([]);
    });

    it('should find spans for all demo agent runs', () => {
      const runIds = ['demo-agent-run-001', 'demo-agent-run-002', 'demo-agent-run-003', 'demo-agent-run-004', 'demo-agent-run-005'];
      runIds.forEach((runId) => {
        const spans = getSampleSpansForRunId(runId);
        expect(spans.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getSampleSpansForRunIds', () => {
    it('should return spans for multiple run IDs', () => {
      const spans = getSampleSpansForRunIds(['demo-agent-run-001', 'demo-agent-run-002']);
      expect(spans.length).toBeGreaterThan(0);
    });

    it('should return empty array for empty input', () => {
      const spans = getSampleSpansForRunIds([]);
      expect(spans).toEqual([]);
    });

    it('should return empty array for null/undefined input', () => {
      const spans = getSampleSpansForRunIds(null as any);
      expect(spans).toEqual([]);
    });

    it('should return spans from different traces', () => {
      const spans = getSampleSpansForRunIds(['demo-agent-run-001', 'demo-agent-run-002']);
      const traceIds = new Set(spans.map((s) => s.traceId));
      expect(traceIds.size).toBe(2);
    });
  });

  describe('getSampleSpansByTraceId', () => {
    it('should return spans for specific trace ID', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.traceId).toBe('demo-trace-001');
      });
    });

    it('should return empty array for unknown trace ID', () => {
      const spans = getSampleSpansByTraceId('unknown-trace');
      expect(spans).toEqual([]);
    });
  });

  describe('getAllSampleTraceSpans', () => {
    it('should return a copy of all spans', () => {
      const spans = getAllSampleTraceSpans();
      expect(spans.length).toBe(SAMPLE_TRACE_SPANS.length);

      // Verify it's a copy
      const originalLength = SAMPLE_TRACE_SPANS.length;
      spans.push({
        traceId: 'new-trace',
        spanId: 'new-span',
        name: 'test',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        duration: 1000,
        status: 'OK',
        attributes: {},
      });
      expect(SAMPLE_TRACE_SPANS.length).toBe(originalLength);
    });
  });

  describe('isSampleTraceId', () => {
    it('should return true for demo-trace- prefix', () => {
      expect(isSampleTraceId('demo-trace-001')).toBe(true);
      expect(isSampleTraceId('demo-trace-anything')).toBe(true);
    });

    it('should return false for non-demo trace IDs', () => {
      expect(isSampleTraceId('trace-001')).toBe(false);
      expect(isSampleTraceId('random-id')).toBe(false);
      expect(isSampleTraceId('')).toBe(false);
    });
  });

  describe('getSampleTraceIds', () => {
    it('should return unique trace IDs', () => {
      const traceIds = getSampleTraceIds();
      expect(traceIds.length).toBe(6);
      expect(new Set(traceIds).size).toBe(traceIds.length);
    });

    it('should contain demo trace IDs', () => {
      const traceIds = getSampleTraceIds();
      traceIds.forEach((id) => {
        expect(id).toMatch(/^demo-trace-/);
      });
    });
  });

  describe('Trace Scenarios', () => {
    describe('Weekend Trip (demo-trace-001)', () => {
      it('should have Travel Coordinator as root agent', () => {
        const spans = getSampleSpansByTraceId('demo-trace-001');
        const rootSpan = spans.find((s) => !s.parentSpanId);
        expect(rootSpan?.name).toContain('Travel Coordinator');
      });

      it('should have Weather Agent invocation', () => {
        const spans = getSampleSpansByTraceId('demo-trace-001');
        expect(spans.some((s) => s.name.includes('Weather Agent'))).toBe(true);
      });

      it('should have weather forecast tool call', () => {
        const spans = getSampleSpansByTraceId('demo-trace-001');
        expect(spans.some((s) => s.name.includes('get_weather_forecast'))).toBe(true);
      });
    });

    describe('Japan Trip (demo-trace-002)', () => {
      it('should have flight search tool', () => {
        const spans = getSampleSpansByTraceId('demo-trace-002');
        expect(spans.some((s) => s.name.includes('search_flights'))).toBe(true);
      });

      it('should have Events Agent with multi-city search', () => {
        const spans = getSampleSpansByTraceId('demo-trace-002');
        const eventSpans = spans.filter((s) => s.name.includes('find_events'));
        expect(eventSpans.length).toBeGreaterThanOrEqual(3); // Tokyo, Kyoto, Osaka
      });
    });

    describe('Budget Trip (demo-trace-003)', () => {
      it('should have Budget Agent invocation', () => {
        const spans = getSampleSpansByTraceId('demo-trace-003');
        expect(spans.some((s) => s.name.includes('Budget Agent'))).toBe(true);
      });

      it('should have destination cost comparison tool', () => {
        const spans = getSampleSpansByTraceId('demo-trace-003');
        expect(spans.some((s) => s.name.includes('compare_destination_costs'))).toBe(true);
      });
    });

    describe('Group Retreat (demo-trace-004)', () => {
      it('should have catering arrangement tool', () => {
        const spans = getSampleSpansByTraceId('demo-trace-004');
        expect(spans.some((s) => s.name.includes('arrange_catering'))).toBe(true);
      });

      it('should have availability check tool', () => {
        const spans = getSampleSpansByTraceId('demo-trace-004');
        expect(spans.some((s) => s.name.includes('check_availability'))).toBe(true);
      });
    });

    describe('Last-Minute Deal (demo-trace-005)', () => {
      it('should have last-minute deal search', () => {
        const spans = getSampleSpansByTraceId('demo-trace-005');
        expect(spans.some((s) => s.name.includes('search_last_minute_deals'))).toBe(true);
      });

      it('should have deal sold-out event', () => {
        const spans = getSampleSpansByTraceId('demo-trace-005');
        const dealSpan = spans.find((s) => s.name.includes('search_last_minute_deals'));
        expect(dealSpan?.events?.some((e) => e.name === 'deal_sold_out')).toBe(true);
      });

      it('should have Budget Agent for deal validation', () => {
        const spans = getSampleSpansByTraceId('demo-trace-005');
        expect(spans.some((s) => s.name.includes('Budget Agent'))).toBe(true);
      });
    });
  });

  describe('Gen-AI Semantic Conventions', () => {
    it('should have gen_ai attributes on LLM spans', () => {
      const spans = SAMPLE_TRACE_SPANS.filter((s) => s.name.startsWith('chat '));
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.attributes['gen_ai.system']).toBeDefined();
        expect(span.attributes['gen_ai.operation.name']).toBe('chat');
        expect(span.attributes['gen_ai.usage.input_tokens']).toBeDefined();
        expect(span.attributes['gen_ai.usage.output_tokens']).toBeDefined();
      });
    });

    it('should have gen_ai.tool.name on tool spans', () => {
      const spans = SAMPLE_TRACE_SPANS.filter((s) => s.name.startsWith('tools/call '));
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.attributes['gen_ai.tool.name']).toBeDefined();
      });
    });

    it('should have agent type attributes on agent spans', () => {
      const spans = SAMPLE_TRACE_SPANS.filter((s) => s.name.startsWith('invoke_agent '));
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.attributes['gen_ai.agent.name']).toBeDefined();
        expect(span.attributes['gen_ai.agent.type']).toBeDefined();
      });
    });
  });

  describe('getAllSampleTraceSpansWithRecentTimestamps', () => {
    it('should return the same number of spans as getAllSampleTraceSpans', () => {
      const original = getAllSampleTraceSpans();
      const shifted = getAllSampleTraceSpansWithRecentTimestamps();
      expect(shifted.length).toBe(original.length);
    });

    it('should have all timestamps within the last 3 hours', () => {
      const shifted = getAllSampleTraceSpansWithRecentTimestamps();
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;

      shifted.forEach((span) => {
        const start = new Date(span.startTime).getTime();
        const end = new Date(span.endTime).getTime();
        expect(start).toBeGreaterThan(threeHoursAgo);
        expect(end).toBeGreaterThan(threeHoursAgo);
        expect(end).toBeLessThanOrEqual(Date.now() + 60000); // allow 1 min tolerance
      });
    });

    it('should preserve relative ordering within each trace', () => {
      const shifted = getAllSampleTraceSpansWithRecentTimestamps();

      // Group by traceId
      const groups = new Map<string, typeof shifted>();
      shifted.forEach((span) => {
        const group = groups.get(span.traceId) || [];
        group.push(span);
        groups.set(span.traceId, group);
      });

      // For each group, verify startTime ordering matches original
      const original = getAllSampleTraceSpans();
      const origGroups = new Map<string, typeof original>();
      original.forEach((span) => {
        const group = origGroups.get(span.traceId) || [];
        group.push(span);
        origGroups.set(span.traceId, group);
      });

      for (const [traceId, shiftedSpans] of groups) {
        const origSpans = origGroups.get(traceId)!;
        expect(shiftedSpans.length).toBe(origSpans.length);

        // spanIds should be in the same order
        const shiftedIds = shiftedSpans.map((s) => s.spanId);
        const origIds = origSpans.map((s) => s.spanId);
        expect(shiftedIds).toEqual(origIds);
      }
    });

    it('should preserve span durations', () => {
      const original = getAllSampleTraceSpans();
      const shifted = getAllSampleTraceSpansWithRecentTimestamps();

      for (let i = 0; i < original.length; i++) {
        expect(shifted[i].duration).toBe(original[i].duration);
      }
    });

    it('should shift event timestamps within spans', () => {
      const shifted = getAllSampleTraceSpansWithRecentTimestamps();
      const spansWithEvents = shifted.filter((s) => s.events && s.events.length > 0);
      expect(spansWithEvents.length).toBeGreaterThan(0);

      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      spansWithEvents.forEach((span) => {
        span.events!.forEach((event) => {
          const eventTime = new Date(event.time).getTime();
          expect(eventTime).toBeGreaterThan(threeHoursAgo);
        });
      });
    });

    it('should not modify the original SAMPLE_TRACE_SPANS', () => {
      const originalFirst = SAMPLE_TRACE_SPANS[0].startTime;
      getAllSampleTraceSpansWithRecentTimestamps();
      expect(SAMPLE_TRACE_SPANS[0].startTime).toBe(originalFirst);
    });
  });

  describe('Span Relationships', () => {
    it('should have parent-child relationships', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      const childSpans = spans.filter((s) => s.parentSpanId);
      expect(childSpans.length).toBeGreaterThan(0);
    });

    it('should have root spans without parent', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      const rootSpans = spans.filter((s) => !s.parentSpanId);
      expect(rootSpans.length).toBe(1);
    });

    it('should have consistent parent references', () => {
      const allSpans = getAllSampleTraceSpans();
      const spanIds = new Set(allSpans.map((s) => s.spanId));

      allSpans.forEach((span) => {
        if (span.parentSpanId) {
          expect(spanIds.has(span.parentSpanId)).toBe(true);
        }
      });
    });
  });
});
