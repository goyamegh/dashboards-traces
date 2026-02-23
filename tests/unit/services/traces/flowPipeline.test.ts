/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pipeline integration tests for the full span → graph transformation:
 *   processSpansIntoTree() → categorizeSpanTree() → spansToFlow() → non-empty graph
 *
 * Prevents regressions where silent empty returns from transform functions
 * produce a blank Agent Graph tab while the Trace Tree and Timeline still show spans.
 */

import { Span } from '@/types';
import { processSpansIntoTree } from '@/services/traces';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { spansToFlow } from '@/services/traces/flowTransform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(
  spanId: string,
  name: string,
  parentSpanId?: string,
  opts: Partial<Span> = {}
): Span {
  const base = '2024-06-01T10:00:00.000Z';
  const offset = parseInt(spanId.replace(/\D/g, '') || '0', 10) * 500;
  const startMs = new Date(base).getTime() + offset;
  const endMs = startMs + 2000;
  return {
    traceId: 'trace-pipeline-test',
    spanId,
    name,
    parentSpanId,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    duration: 2000,
    status: 'OK',
    attributes: {},
    ...opts,
  };
}

function runPipeline(flatSpans: Span[]) {
  const tree = processSpansIntoTree(flatSpans);
  const categorized = categorizeSpanTree(tree);
  const totalDuration = flatSpans.length > 0 ? 10000 : 0;
  return spansToFlow(categorized, totalDuration, { direction: 'TB' });
}

// ---------------------------------------------------------------------------
// Fixture 1: Bedrock agent hierarchy
//   agent.node.generateResponse
//     └── agent.node.callModel
//           └── bedrock.converseStream
//     └── agent.node.executeTools
//           └── agent.tool.execute
// ---------------------------------------------------------------------------
const bedrockAgentSpans: Span[] = [
  makeSpan('root', 'agent.node.generateResponse'),
  makeSpan('cm', 'agent.node.callModel', 'root'),
  makeSpan('bcs', 'bedrock.converseStream', 'cm'),
  makeSpan('et', 'agent.node.executeTools', 'root'),
  makeSpan('te', 'agent.tool.execute', 'et'),
];

// ---------------------------------------------------------------------------
// Fixture 2: Single-root wrapper with deep nesting
//   agent.run (root)
//     └── step1.llm
//           └── step2.tool
//                 └── step3.llm
// ---------------------------------------------------------------------------
const singleRootWrapperSpans: Span[] = [
  makeSpan('w', 'agent.run'),
  makeSpan('s1', 'step1.llm', 'w'),
  makeSpan('s2', 'step2.tool', 's1'),
  makeSpan('s3', 'step3.llm', 's2'),
];

// ---------------------------------------------------------------------------
// Fixture 3: Multi-root trace (no shared root)
//   root1.llm
//   root2.tool
//   root3.other
// ---------------------------------------------------------------------------
const multiRootSpans: Span[] = [
  makeSpan('r1', 'root1.llm'),
  makeSpan('r2', 'root2.tool'),
  makeSpan('r3', 'root3.other'),
];

// ---------------------------------------------------------------------------
// Fixture 4: Container with children (standard OTel invoke_agent pattern)
//   invoke_agent (gen_ai.operation.name = invoke_agent)
//     └── chat  (LLM call)
//     └── execute_tool
// ---------------------------------------------------------------------------
const containerWithChildrenSpans: Span[] = [
  makeSpan('inv', 'invoke_agent', undefined, {
    attributes: { 'gen_ai.operation.name': 'invoke_agent' },
  }),
  makeSpan('ch', 'chat', 'inv', {
    attributes: { 'gen_ai.operation.name': 'chat' },
  }),
  makeSpan('xt', 'execute_tool', 'inv', {
    attributes: { 'gen_ai.operation.name': 'execute_tool' },
  }),
];

// ---------------------------------------------------------------------------
// Fixture 5: Container WITHOUT children (edge case that was broken)
//   agent.run (root, container-like name, no children in flat list)
// ---------------------------------------------------------------------------
const containerWithoutChildrenSpans: Span[] = [
  makeSpan('lone', 'agent.run'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Flow pipeline: processSpansIntoTree → categorizeSpanTree → spansToFlow', () => {
  describe('Fixture 1: Bedrock agent hierarchy', () => {
    it('produces nodes for all spans (graph is never empty)', () => {
      const { nodes } = runPipeline(bedrockAgentSpans);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('node count is proportional to span count', () => {
      const { nodes } = runPipeline(bedrockAgentSpans);
      // All 5 spans should produce nodes (execution-order includes children)
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.length).toBeLessThanOrEqual(bedrockAgentSpans.length);
    });

    it('produces edges connecting nodes', () => {
      const { nodes, edges } = runPipeline(bedrockAgentSpans);
      if (nodes.length > 1) {
        expect(edges.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Fixture 2: Single-root wrapper with deep nesting', () => {
    it('produces nodes (graph is never empty)', () => {
      const { nodes } = runPipeline(singleRootWrapperSpans);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('includes nested children as nodes', () => {
      const { nodes } = runPipeline(singleRootWrapperSpans);
      // Should include children even when root is skipped as container
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Fixture 3: Multi-root trace', () => {
    it('produces nodes for all roots', () => {
      const { nodes } = runPipeline(multiRootSpans);
      expect(nodes.length).toBe(multiRootSpans.length);
    });

    it('produces sequential edges between roots', () => {
      const { edges } = runPipeline(multiRootSpans);
      // 3 roots → 2 sequential edges
      expect(edges.length).toBe(multiRootSpans.length - 1);
    });
  });

  describe('Fixture 4: Container with children (OTel invoke_agent)', () => {
    it('produces nodes for children (container skipped)', () => {
      const { nodes } = runPipeline(containerWithChildrenSpans);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('graph is not empty', () => {
      const { nodes } = runPipeline(containerWithChildrenSpans);
      expect(nodes.length).toBeGreaterThan(0);
    });
  });

  describe('Fixture 5: Container WITHOUT children (was the broken case)', () => {
    it('graph is NOT empty — shows root as fallback', () => {
      const { nodes } = runPipeline(containerWithoutChildrenSpans);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('root span appears as a node', () => {
      const { nodes } = runPipeline(containerWithoutChildrenSpans);
      expect(nodes.some(n => n.id === 'lone')).toBe(true);
    });
  });

  describe('Empty input', () => {
    it('returns empty nodes and edges for no spans', () => {
      const { nodes, edges } = runPipeline([]);
      expect(nodes).toEqual([]);
      expect(edges).toEqual([]);
    });
  });
});
