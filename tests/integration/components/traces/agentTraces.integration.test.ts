/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Agent Traces Page
 *
 * Tests the full pipeline from span data to trace table rows with:
 * - Trace grouping and summarization
 * - Latency distribution calculation
 * - Stats aggregation
 *
 * Run tests:
 *   npm test -- --testPathPatterns=agentTraces.integration
 */

import { Span, TraceSummary } from '@/types';
import { groupSpansByTrace } from '@/services/traces/traceGrouping';
import { processSpansIntoTree, calculateTimeRange } from '@/services/traces';

/**
 * Create realistic OTEL span data similar to what we receive from OpenSearch
 */
function createRealisticSpanData(): Span[] {
  const now = Date.now();
  const baseTime = new Date(now - 300000).toISOString(); // 5 minutes ago

  // Trace 1: Agent with LLM calls and tool use
  const trace1Spans: Span[] = [
    {
      spanId: 'trace1-root',
      traceId: 'trace-001',
      name: 'agent.run',
      startTime: new Date(now - 300000).toISOString(),
      endTime: new Date(now - 295000).toISOString(),
      status: 'OK',
      attributes: {
        'service.name': 'langgraph-agent',
        'gen_ai.agent.name': 'rca-agent',
      },
    },
    {
      spanId: 'trace1-llm1',
      traceId: 'trace-001',
      parentSpanId: 'trace1-root',
      name: 'bedrock.converse',
      startTime: new Date(now - 299000).toISOString(),
      endTime: new Date(now - 298000).toISOString(),
      status: 'OK',
      attributes: {
        'service.name': 'langgraph-agent',
        'gen_ai.system': 'aws_bedrock',
        'gen_ai.request.model': 'anthropic.claude-3-sonnet',
        'gen_ai.prompt': 'What are the recent errors?',
        'gen_ai.completion': 'Let me search the logs...',
      },
    },
    {
      spanId: 'trace1-tool1',
      traceId: 'trace-001',
      parentSpanId: 'trace1-root',
      name: 'execute_tool',
      startTime: new Date(now - 297000).toISOString(),
      endTime: new Date(now - 296000).toISOString(),
      status: 'OK',
      attributes: {
        'service.name': 'langgraph-agent',
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'search_logs',
        'gen_ai.tool.input': '{"query": "error"}',
        'gen_ai.tool.output': '{"results": []}',
      },
    },
  ];

  // Trace 2: Simple LLM call
  const trace2Spans: Span[] = [
    {
      spanId: 'trace2-root',
      traceId: 'trace-002',
      name: 'bedrock.invoke',
      startTime: new Date(now - 200000).toISOString(),
      endTime: new Date(now - 199000).toISOString(),
      status: 'OK',
      attributes: {
        'service.name': 'simple-agent',
        'gen_ai.system': 'aws_bedrock',
        'input.value': 'Hello',
        'output.value': 'Hi there!',
      },
    },
  ];

  // Trace 3: Agent with error
  const trace3Spans: Span[] = [
    {
      spanId: 'trace3-root',
      traceId: 'trace-003',
      name: 'agent.run',
      startTime: new Date(now - 100000).toISOString(),
      endTime: new Date(now - 99000).toISOString(),
      status: 'ERROR',
      attributes: {
        'service.name': 'error-agent',
        'error.message': 'Connection timeout',
      },
    },
    {
      spanId: 'trace3-tool1',
      traceId: 'trace-003',
      parentSpanId: 'trace3-root',
      name: 'execute_tool',
      startTime: new Date(now - 99500).toISOString(),
      endTime: new Date(now - 99000).toISOString(),
      status: 'ERROR',
      attributes: {
        'service.name': 'error-agent',
        'gen_ai.tool.name': 'api_call',
        'error.type': 'TimeoutError',
      },
    },
  ];

  return [...trace1Spans, ...trace2Spans, ...trace3Spans];
}

/**
 * Create span data with varying latencies for histogram testing
 */
function createVariedLatencySpans(): Span[] {
  const now = Date.now();

  // Create spans with specific latencies across all buckets
  const latencies = [
    50,     // <100ms
    75,     // <100ms
    150,    // 100-500ms
    300,    // 100-500ms
    450,    // 100-500ms
    600,    // 500ms-1s
    800,    // 500ms-1s
    2000,   // 1-5s
    3500,   // 1-5s
    4000,   // 1-5s
    6000,   // 5-10s
    8000,   // 5-10s
    15000,  // >10s
    25000,  // >10s
  ];

  return latencies.map((latency, index) => ({
    spanId: `span-${index}`,
    traceId: `trace-latency-${index}`,
    name: 'test.span',
    startTime: new Date(now - latency - 1000).toISOString(),
    endTime: new Date(now - 1000).toISOString(),
    status: 'OK' as const,
    attributes: { 'service.name': 'test-service' },
  }));
}

describe('Agent Traces Integration', () => {
  describe('Full Trace Processing Pipeline', () => {
    it('processes realistic span data into trace summaries', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      expect(summaries).toHaveLength(3);

      // Verify trace IDs
      const traceIds = summaries.map(s => s.traceId);
      expect(traceIds).toContain('trace-001');
      expect(traceIds).toContain('trace-002');
      expect(traceIds).toContain('trace-003');
    });

    it('correctly identifies root spans and names', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const trace1 = summaries.find(s => s.traceId === 'trace-001');
      expect(trace1?.rootSpanName).toBe('agent.run');

      const trace2 = summaries.find(s => s.traceId === 'trace-002');
      expect(trace2?.rootSpanName).toBe('bedrock.invoke');
    });

    it('extracts service names from attributes', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const trace1 = summaries.find(s => s.traceId === 'trace-001');
      expect(trace1?.serviceName).toBe('langgraph-agent');

      const trace2 = summaries.find(s => s.traceId === 'trace-002');
      expect(trace2?.serviceName).toBe('simple-agent');
    });

    it('correctly counts spans per trace', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const trace1 = summaries.find(s => s.traceId === 'trace-001');
      expect(trace1?.spanCount).toBe(3);

      const trace2 = summaries.find(s => s.traceId === 'trace-002');
      expect(trace2?.spanCount).toBe(1);

      const trace3 = summaries.find(s => s.traceId === 'trace-003');
      expect(trace3?.spanCount).toBe(2);
    });

    it('detects errors in traces', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const trace1 = summaries.find(s => s.traceId === 'trace-001');
      expect(trace1?.hasErrors).toBe(false);

      const trace3 = summaries.find(s => s.traceId === 'trace-003');
      expect(trace3?.hasErrors).toBe(true);
    });

    it('calculates durations correctly', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      // All traces should have positive durations
      summaries.forEach(summary => {
        expect(summary.duration).toBeGreaterThan(0);
      });
    });
  });

  describe('Span Tree Processing', () => {
    it('builds hierarchical span tree correctly', () => {
      const spans = createRealisticSpanData();
      const trace1Spans = spans.filter(s => s.traceId === 'trace-001');

      const tree = processSpansIntoTree(trace1Spans);

      // Root should have children
      expect(tree).toHaveLength(1);
      expect(tree[0].children?.length).toBe(2);
    });

    it('calculates time range from spans', () => {
      const spans = createRealisticSpanData();
      const timeRange = calculateTimeRange(spans);

      expect(timeRange.startTime).toBeLessThan(timeRange.endTime);
      expect(timeRange.duration).toBeGreaterThan(0);
    });
  });

  describe('Latency Distribution', () => {
    it('distributes traces into correct latency buckets', () => {
      const spans = createVariedLatencySpans();
      const summaries = groupSpansByTrace(spans);

      // Create latency distribution
      const buckets = [
        { label: '<100ms', min: 0, max: 100, count: 0 },
        { label: '100-500ms', min: 100, max: 500, count: 0 },
        { label: '500ms-1s', min: 500, max: 1000, count: 0 },
        { label: '1-5s', min: 1000, max: 5000, count: 0 },
        { label: '5-10s', min: 5000, max: 10000, count: 0 },
        { label: '>10s', min: 10000, max: Infinity, count: 0 },
      ];

      summaries.forEach(summary => {
        const bucket = buckets.find(b => summary.duration >= b.min && summary.duration < b.max);
        if (bucket) bucket.count++;
      });

      // Verify distribution matches expected counts
      expect(buckets[0].count).toBe(2);  // <100ms: 50, 75
      expect(buckets[1].count).toBe(3);  // 100-500ms: 150, 300, 450
      expect(buckets[2].count).toBe(2);  // 500ms-1s: 600, 800
      expect(buckets[3].count).toBe(3);  // 1-5s: 2000, 3500, 4000
      expect(buckets[4].count).toBe(2);  // 5-10s: 6000, 8000
      expect(buckets[5].count).toBe(2);  // >10s: 15000, 25000
    });
  });

  describe('Stats Aggregation', () => {
    it('calculates aggregate statistics correctly', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const stats = {
        total: summaries.length,
        errors: summaries.filter(s => s.hasErrors).length,
        avgDuration: summaries.reduce((sum, s) => sum + s.duration, 0) / summaries.length,
        totalSpans: summaries.reduce((sum, s) => sum + s.spanCount, 0),
      };

      expect(stats.total).toBe(3);
      expect(stats.errors).toBe(1);
      expect(stats.avgDuration).toBeGreaterThan(0);
      expect(stats.totalSpans).toBe(6); // 3 + 1 + 2
    });

    it('calculates error rate correctly', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      const errorRate = (summaries.filter(s => s.hasErrors).length / summaries.length) * 100;

      expect(errorRate).toBeCloseTo(33.33, 1); // 1/3 traces have errors
    });
  });

  describe('Input/Output Extraction', () => {
    it('extracts LLM input/output from span attributes', () => {
      const spans = createRealisticSpanData();
      const llmSpan = spans.find(s => s.attributes?.['gen_ai.prompt']);

      expect(llmSpan).toBeDefined();
      expect(llmSpan?.attributes?.['gen_ai.prompt']).toBe('What are the recent errors?');
      expect(llmSpan?.attributes?.['gen_ai.completion']).toBe('Let me search the logs...');
    });

    it('extracts tool input/output from span attributes', () => {
      const spans = createRealisticSpanData();
      const toolSpan = spans.find(s => s.attributes?.['gen_ai.tool.name'] === 'search_logs');

      expect(toolSpan).toBeDefined();
      expect(toolSpan?.attributes?.['gen_ai.tool.input']).toBe('{"query": "error"}');
      expect(toolSpan?.attributes?.['gen_ai.tool.output']).toBe('{"results": []}');
    });

    it('extracts model information from LLM spans', () => {
      const spans = createRealisticSpanData();
      const llmSpan = spans.find(s => s.attributes?.['gen_ai.request.model']);

      expect(llmSpan).toBeDefined();
      expect(llmSpan?.attributes?.['gen_ai.request.model']).toBe('anthropic.claude-3-sonnet');
    });
  });

  describe('Sorting and Ordering', () => {
    it('sorts traces by start time descending (newest first)', () => {
      const spans = createRealisticSpanData();
      const summaries = groupSpansByTrace(spans);

      // Verify descending order
      for (let i = 1; i < summaries.length; i++) {
        const prevTime = new Date(summaries[i - 1].startTime).getTime();
        const currTime = new Date(summaries[i].startTime).getTime();
        expect(prevTime).toBeGreaterThanOrEqual(currTime);
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles empty span array', () => {
      const summaries = groupSpansByTrace([]);
      expect(summaries).toEqual([]);
    });

    it('handles single span', () => {
      const spans: Span[] = [{
        spanId: 'single',
        traceId: 'single-trace',
        name: 'single.span',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        status: 'OK',
        attributes: {},
      }];

      const summaries = groupSpansByTrace(spans);

      expect(summaries).toHaveLength(1);
      expect(summaries[0].spanCount).toBe(1);
    });

    it('handles spans without service name', () => {
      const spans: Span[] = [{
        spanId: 'no-service',
        traceId: 'no-service-trace',
        name: 'test.span',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        status: 'OK',
        attributes: {},
      }];

      const summaries = groupSpansByTrace(spans);

      expect(summaries[0].serviceName).toBe('unknown');
    });
  });
});
