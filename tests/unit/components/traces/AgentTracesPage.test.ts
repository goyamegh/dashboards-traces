/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for AgentTracesPage component logic
 *
 * Tests the trace processing and table row generation logic.
 */

import { Span, TraceSummary } from '@/types';
import { groupSpansByTrace } from '@/services/traces';

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

// Replicate the trace row processing logic from AgentTracesPage
interface TraceTableRow {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTime: Date;
  duration: number;
  spanCount: number;
  hasErrors: boolean;
  spans: Span[];
}

function processSpansToTraces(allSpans: Span[]): TraceTableRow[] {
  const traceGroups = groupSpansByTrace(allSpans);

  return traceGroups.map(group => {
    const rootSpan = group.spans.find(s => !s.parentSpanId) || group.spans[0];
    const hasErrors = group.spans.some(s => s.status === 'ERROR');

    const times = group.spans.map(s => ({
      start: new Date(s.startTime).getTime(),
      end: new Date(s.endTime).getTime(),
    }));
    const minStart = Math.min(...times.map(t => t.start));
    const maxEnd = Math.max(...times.map(t => t.end));

    return {
      traceId: group.traceId,
      rootSpanName: rootSpan.name,
      serviceName: rootSpan.attributes?.['service.name'] || 'unknown',
      startTime: new Date(minStart),
      duration: maxEnd - minStart,
      spanCount: group.spans.length,
      hasErrors,
      spans: group.spans,
    };
  }).sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
}

describe('AgentTracesPage - processSpansToTraces', () => {
  describe('basic grouping', () => {
    it('groups spans by trace ID', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1', name: 'root-1' }),
        createSpan({ traceId: 'trace-1', spanId: '2', name: 'child-1', parentSpanId: '1' }),
        createSpan({ traceId: 'trace-2', spanId: '3', name: 'root-2' }),
      ];

      const result = processSpansToTraces(spans);

      expect(result).toHaveLength(2);
      expect(result.map(r => r.traceId)).toContain('trace-1');
      expect(result.map(r => r.traceId)).toContain('trace-2');
    });

    it('counts spans correctly per trace', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1' }),
        createSpan({ traceId: 'trace-1', spanId: '2', parentSpanId: '1' }),
        createSpan({ traceId: 'trace-1', spanId: '3', parentSpanId: '1' }),
        createSpan({ traceId: 'trace-2', spanId: '4' }),
      ];

      const result = processSpansToTraces(spans);

      const trace1 = result.find(r => r.traceId === 'trace-1');
      const trace2 = result.find(r => r.traceId === 'trace-2');

      expect(trace1?.spanCount).toBe(3);
      expect(trace2?.spanCount).toBe(1);
    });
  });

  describe('root span detection', () => {
    it('uses span without parentSpanId as root', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: 'child', name: 'child-span', parentSpanId: 'root' }),
        createSpan({ traceId: 'trace-1', spanId: 'root', name: 'root-span' }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].rootSpanName).toBe('root-span');
    });

    it('falls back to first span if no root found', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1', name: 'first-span', parentSpanId: 'missing' }),
        createSpan({ traceId: 'trace-1', spanId: '2', name: 'second-span', parentSpanId: 'missing' }),
      ];

      const result = processSpansToTraces(spans);

      // Should use first span when all have parent IDs
      expect(result[0].rootSpanName).toBe('first-span');
    });
  });

  describe('error detection', () => {
    it('detects error in trace when any span has ERROR status', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1', status: 'OK' }),
        createSpan({ traceId: 'trace-1', spanId: '2', status: 'ERROR', parentSpanId: '1' }),
        createSpan({ traceId: 'trace-1', spanId: '3', status: 'OK', parentSpanId: '1' }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].hasErrors).toBe(true);
    });

    it('reports no errors when all spans are OK', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1', status: 'OK' }),
        createSpan({ traceId: 'trace-1', spanId: '2', status: 'OK', parentSpanId: '1' }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].hasErrors).toBe(false);
    });

    it('handles UNSET status as non-error', () => {
      const spans = [
        createSpan({ traceId: 'trace-1', spanId: '1', status: 'UNSET' }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].hasErrors).toBe(false);
    });
  });

  describe('duration calculation', () => {
    it('calculates duration from span time range', () => {
      const spans = [
        createSpan({
          traceId: 'trace-1',
          spanId: '1',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].duration).toBe(5000); // 5 seconds in ms
    });

    it('calculates duration across multiple spans', () => {
      const spans = [
        createSpan({
          traceId: 'trace-1',
          spanId: '1',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:02Z',
        }),
        createSpan({
          traceId: 'trace-1',
          spanId: '2',
          parentSpanId: '1',
          startTime: '2024-01-01T00:00:01Z',
          endTime: '2024-01-01T00:00:05Z', // Extends past parent
        }),
      ];

      const result = processSpansToTraces(spans);

      // Duration should be from earliest start to latest end
      expect(result[0].duration).toBe(5000); // 0:00:00 to 0:00:05
    });
  });

  describe('service name extraction', () => {
    it('extracts service name from root span attributes', () => {
      const spans = [
        createSpan({
          traceId: 'trace-1',
          spanId: '1',
          attributes: { 'service.name': 'my-agent-service' },
        }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].serviceName).toBe('my-agent-service');
    });

    it('defaults to unknown when no service name', () => {
      const spans = [
        createSpan({
          traceId: 'trace-1',
          spanId: '1',
          attributes: {},
        }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].serviceName).toBe('unknown');
    });
  });

  describe('sorting', () => {
    it('sorts traces by start time descending (newest first)', () => {
      const spans = [
        createSpan({
          traceId: 'trace-old',
          spanId: '1',
          startTime: '2024-01-01T00:00:00Z',
        }),
        createSpan({
          traceId: 'trace-new',
          spanId: '2',
          startTime: '2024-01-02T00:00:00Z',
        }),
        createSpan({
          traceId: 'trace-middle',
          spanId: '3',
          startTime: '2024-01-01T12:00:00Z',
        }),
      ];

      const result = processSpansToTraces(spans);

      expect(result[0].traceId).toBe('trace-new');
      expect(result[1].traceId).toBe('trace-middle');
      expect(result[2].traceId).toBe('trace-old');
    });
  });

  describe('empty input', () => {
    it('returns empty array for empty input', () => {
      const result = processSpansToTraces([]);
      expect(result).toEqual([]);
    });
  });
});

describe('AgentTracesPage - latency distribution', () => {
  // Replicate the latency distribution logic
  function calculateLatencyDistribution(traces: TraceTableRow[]) {
    if (traces.length === 0) return [];

    const buckets = [
      { label: '<100ms', min: 0, max: 100, count: 0 },
      { label: '100-500ms', min: 100, max: 500, count: 0 },
      { label: '500ms-1s', min: 500, max: 1000, count: 0 },
      { label: '1-5s', min: 1000, max: 5000, count: 0 },
      { label: '5-10s', min: 5000, max: 10000, count: 0 },
      { label: '>10s', min: 10000, max: Infinity, count: 0 },
    ];

    traces.forEach(trace => {
      const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
      if (bucket) bucket.count++;
    });

    return buckets;
  }

  it('distributes traces into latency buckets', () => {
    const traces: TraceTableRow[] = [
      { traceId: '1', duration: 50, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '2', duration: 200, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '3', duration: 750, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '4', duration: 3000, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '5', duration: 8000, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '6', duration: 15000, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
    ];

    const distribution = calculateLatencyDistribution(traces);

    expect(distribution[0].count).toBe(1); // <100ms
    expect(distribution[1].count).toBe(1); // 100-500ms
    expect(distribution[2].count).toBe(1); // 500ms-1s
    expect(distribution[3].count).toBe(1); // 1-5s
    expect(distribution[4].count).toBe(1); // 5-10s
    expect(distribution[5].count).toBe(1); // >10s
  });

  it('returns empty array for empty traces', () => {
    const distribution = calculateLatencyDistribution([]);
    expect(distribution).toEqual([]);
  });
});

describe('AgentTracesPage - stats calculation', () => {
  function calculateStats(traces: TraceTableRow[]) {
    if (traces.length === 0) return { total: 0, errors: 0, avgDuration: 0 };

    const errors = traces.filter(t => t.hasErrors).length;
    const avgDuration = traces.reduce((sum, t) => sum + t.duration, 0) / traces.length;

    return {
      total: traces.length,
      errors,
      avgDuration,
    };
  }

  it('calculates total trace count', () => {
    const traces: TraceTableRow[] = [
      { traceId: '1', duration: 100, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '2', duration: 200, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '3', duration: 300, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: true, spans: [] },
    ];

    const stats = calculateStats(traces);
    expect(stats.total).toBe(3);
  });

  it('calculates error count', () => {
    const traces: TraceTableRow[] = [
      { traceId: '1', duration: 100, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '2', duration: 200, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: true, spans: [] },
      { traceId: '3', duration: 300, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: true, spans: [] },
    ];

    const stats = calculateStats(traces);
    expect(stats.errors).toBe(2);
  });

  it('calculates average duration', () => {
    const traces: TraceTableRow[] = [
      { traceId: '1', duration: 100, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '2', duration: 200, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
      { traceId: '3', duration: 300, rootSpanName: '', serviceName: '', startTime: new Date(), spanCount: 1, hasErrors: false, spans: [] },
    ];

    const stats = calculateStats(traces);
    expect(stats.avgDuration).toBe(200); // (100 + 200 + 300) / 3
  });

  it('handles empty traces', () => {
    const stats = calculateStats([]);
    expect(stats.total).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.avgDuration).toBe(0);
  });
});
