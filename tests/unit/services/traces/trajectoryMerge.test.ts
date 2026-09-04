/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import { ToolCallStatus } from '@/types';
import {
  hasToolOutput,
  mergeSpanTrajectory,
  spanTrajectoryLosesToolEvidence,
  toolEvidenceChars,
  toolEvidenceText,
} from '@/services/traces/trajectoryMerge';

let n = 0;
function step(partial: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type' | 'content'>): TrajectoryStep {
  return { id: `s-${++n}`, timestamp: 1_700_000_000_000 + n, ...partial };
}

/** Connector (afterResponse-hook) trajectory of a REST retrieval agent. */
function restConnectorTrajectory(): TrajectoryStep[] {
  return [
    step({ type: 'action', content: '{"index":"kb"}', toolName: 'dsl_executor', toolArgs: { index: 'kb' } }),
    step({
      type: 'tool_result', content: '[{"id":597374,"title":"Away Kit"}]', toolName: 'dsl_executor',
      toolOutput: '[{"id":597374,"title":"Away Kit"}]', status: ToolCallStatus.SUCCESS,
    }),
    step({ type: 'action', content: '{"index":"kb","q":"adidas"}', toolName: 'dsl_executor' }),
    step({
      type: 'tool_result', content: '[{"id":1}]', toolName: 'dsl_executor',
      toolOutput: '[{"id":1}]', status: ToolCallStatus.SUCCESS,
    }),
    step({ type: 'response', content: 'The product is 597374.' }),
  ];
}

describe('trajectoryMerge — evidence-preserving replacement policy', () => {
  describe('hasToolOutput', () => {
    it('is true only for tool_result steps with a non-empty toolOutput', () => {
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: 'x' }))).toBe(true);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: { a: 1 } }))).toBe(true);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: ['a'] }))).toBe(true);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'tool succeeded' }))).toBe(false);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: '' }))).toBe(false);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: '   ' }))).toBe(false);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: {} }))).toBe(false);
      expect(hasToolOutput(step({ type: 'tool_result', content: 'x', toolOutput: [] }))).toBe(false);
      expect(hasToolOutput(step({ type: 'action', content: 'x', toolOutput: 'x' }))).toBe(false);
      expect(hasToolOutput(undefined)).toBe(false);
      expect(hasToolOutput(null)).toBe(false);
    });
  });

  describe('toolEvidenceText / toolEvidenceChars', () => {
    it('prefers toolOutput, falls back to content, and ignores non-result steps', () => {
      expect(toolEvidenceText(step({ type: 'tool_result', content: 'c', toolOutput: 'out' }))).toBe('out');
      expect(toolEvidenceText(step({ type: 'tool_result', content: 'c', toolOutput: { a: 1 } }))).toBe('{"a":1}');
      expect(toolEvidenceText(step({ type: 'tool_result', content: 'content only' }))).toBe('content only');
      expect(toolEvidenceText(step({ type: 'tool_result', content: 'c', toolOutput: {} }))).toBe('c');
      expect(toolEvidenceText(step({ type: 'action', content: 'ignored', toolOutput: 'ignored' }))).toBe('');
      expect(toolEvidenceText(undefined)).toBe('');
      expect(toolEvidenceChars([
        step({ type: 'tool_result', content: 'abc' }),
        step({ type: 'tool_result', content: 'x', toolOutput: 'defgh' }),
        step({ type: 'response', content: 'not counted' }),
      ])).toBe(8);
    });
  });

  describe('spanTrajectoryLosesToolEvidence', () => {
    it('is false when the connector has no tool steps (nothing to lose)', () => {
      const connector = [step({ type: 'response', content: 'answer' })];
      expect(spanTrajectoryLosesToolEvidence(connector, [])).toBe(false);
      expect(spanTrajectoryLosesToolEvidence(connector, [step({ type: 'action', content: 'a' })])).toBe(false);
    });

    it('is true when the span trajectory has fewer tool steps', () => {
      // Shape measured live: the REST agent's spans carried only the prompt
      // and completion — the span trajectory had NO tool steps at all.
      const span = [
        step({ type: 'thinking', content: 'User: find the away kit' }),
        step({ type: 'response', content: 'The product is 597374.' }),
      ];
      expect(spanTrajectoryLosesToolEvidence(restConnectorTrajectory(), span)).toBe(true);
    });

    it('is true when the span tool_results are output-less stubs and the connector had outputs', () => {
      // Shape measured live for a subprocess agent: `tool` / `tool.execution`
      // spans with no payload attributes → "tool succeeded" stubs.
      const span = [
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 120 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 118 }),
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 40 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 39 }),
      ];
      expect(spanTrajectoryLosesToolEvidence(restConnectorTrajectory(), span)).toBe(true);
    });

    it('is true for content-only connector results (generic REST / AG-UI connectors set no toolOutput) vs span stubs', () => {
      const connector = [
        step({ type: 'action', content: 'Calling search...', toolName: 'search' }),
        step({ type: 'tool_result', content: '{"hits":[{"id":1},{"id":2},{"id":3}]}' }), // content only
        step({ type: 'response', content: 'done' }),
      ];
      const span = [
        step({ type: 'action', content: 'search', toolName: 'search' }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'search' }),
      ];
      expect(spanTrajectoryLosesToolEvidence(connector, span)).toBe(true);
    });

    it('is false when the span tool steps are at least as complete (trace-only agent, #320)', () => {
      const connector = [
        step({ type: 'action', content: 'a', toolName: 'search' }),
        step({ type: 'tool_result', content: 'r', toolName: 'search', toolOutput: 'r' }),
        step({ type: 'response', content: 'done' }),
      ];
      const span = [
        step({ type: 'action', content: 'a', toolName: 'search' }),
        step({ type: 'tool_result', content: 'r', toolName: 'search', toolOutput: 'r' }),
        step({ type: 'action', content: 'b', toolName: 'search' }),
        step({ type: 'tool_result', content: 'r2', toolName: 'search', toolOutput: 'r2' }),
      ];
      expect(spanTrajectoryLosesToolEvidence(connector, span)).toBe(false);
    });

    it('is false when the spans carry MORE evidence than status-only connector results (Kiro-style)', () => {
      const connector = [
        step({ type: 'action', content: '{"command":"grep foo"}', toolName: 'grep' }),
        step({ type: 'tool_result', content: 'status: Completed', toolName: 'grep' }),
      ];
      const span = [
        step({ type: 'action', content: 'grep foo', toolName: 'grep' }),
        step({ type: 'tool_result', content: 'src/a.ts:12: foo()\nsrc/b.ts:3: foo', toolName: 'grep', toolOutput: 'src/a.ts:12: foo()\nsrc/b.ts:3: foo' }),
      ];
      expect(spanTrajectoryLosesToolEvidence(connector, span)).toBe(false);
    });

    it('is false when the connector tool_results were themselves stubs of equal size and counts match', () => {
      const connector = [
        step({ type: 'action', content: 'a', toolName: 't' }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 't' }),
      ];
      const span = [
        step({ type: 'action', content: 'a', toolName: 't' }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 't' }),
      ];
      expect(spanTrajectoryLosesToolEvidence(connector, span)).toBe(false);
    });
  });

  describe('mergeSpanTrajectory', () => {
    it('returns the connector trajectory untouched when the span trajectory is empty', () => {
      const connector = restConnectorTrajectory();
      expect(mergeSpanTrajectory(connector, [])).toEqual(connector);
      expect(mergeSpanTrajectory(undefined, [])).toEqual([]);
      expect(mergeSpanTrajectory(null, [])).toEqual([]);
    });

    it('keeps the connector tool_result outputs when the spans carry no tool steps (REST agent)', () => {
      const connector = restConnectorTrajectory();
      const span = [
        step({ type: 'thinking', content: 'User: find the away kit' }),
        step({ type: 'response', content: 'The product is 597374.' }),
      ];
      const merged = mergeSpanTrajectory(connector, span);

      const tools = merged.filter((s) => s.type === 'action' || s.type === 'tool_result');
      expect(tools).toHaveLength(4);
      expect(merged.filter((s) => s.type === 'tool_result').every((s) => typeof s.toolOutput === 'string' && s.toolOutput.length > 0)).toBe(true);
      expect(merged.filter((s) => s.type === 'tool_result').map((s) => s.toolOutput)).toEqual([
        '[{"id":597374,"title":"Away Kit"}]',
        '[{"id":1}]',
      ]);
      // The agent's answer is present exactly once.
      expect(merged.filter((s) => s.type === 'response')).toHaveLength(1);
    });

    it('keeps connector outputs over span "tool succeeded" stubs and folds span timing onto them', () => {
      const connector = restConnectorTrajectory();
      const span = [
        step({ type: 'assistant', content: '[LLM model · stop=tool_use]' }),
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 120 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 118 }),
        step({ type: 'assistant', content: '[LLM model · stop=tool_use]' }),
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 40 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 39 }),
        step({ type: 'assistant', content: '[LLM model · stop=end_turn]' }),
      ];
      const merged = mergeSpanTrajectory(connector, span);

      const results = merged.filter((s) => s.type === 'tool_result');
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.toolOutput)).toEqual(['[{"id":597374,"title":"Away Kit"}]', '[{"id":1}]']);
      expect(results.map((s) => s.content)).not.toContain('tool succeeded');
      // Timing from the spans is folded onto the connector steps by position.
      expect(merged.filter((s) => s.type === 'action').map((s) => s.latencyMs)).toEqual([120, 40]);
      expect(results.map((s) => s.latencyMs)).toEqual([118, 39]);
      // Original ids are preserved (the connector steps are the judged steps).
      expect(merged.map((s) => s.id)).toEqual(connector.map((s) => s.id));
    });

    it('never reduces the tool-step count below the connector\'s', () => {
      const connector = restConnectorTrajectory();
      const spanFewer = [
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor' }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor' }),
      ];
      const merged = mergeSpanTrajectory(connector, spanFewer);
      const count = (t: TrajectoryStep[]) => t.filter((s) => s.type === 'action' || s.type === 'tool_result').length;
      expect(count(merged)).toBeGreaterThanOrEqual(count(connector));
      expect(merged.filter((s) => s.type === 'tool_result').every(hasToolOutput)).toBe(true);
    });

    it('never reduces tool evidence bytes (property check over mixed shapes)', () => {
      const shapes: Array<[TrajectoryStep[], TrajectoryStep[]]> = [
        [restConnectorTrajectory(), []],
        [restConnectorTrajectory(), [step({ type: 'response', content: 'x' })]],
        [restConnectorTrajectory(), [step({ type: 'action', content: 'a' }), step({ type: 'tool_result', content: 'tool succeeded' })]],
        [[step({ type: 'response', content: 'only' })], [step({ type: 'action', content: 'a' }), step({ type: 'tool_result', content: 'big'.repeat(50), toolOutput: 'big'.repeat(50) })]],
        [[step({ type: 'tool_result', content: 'status: Completed' })], [step({ type: 'tool_result', content: 'real output here', toolOutput: 'real output here' })]],
      ];
      for (const [connector, span] of shapes) {
        const merged = mergeSpanTrajectory(connector, span);
        expect(toolEvidenceChars(merged)).toBeGreaterThanOrEqual(toolEvidenceChars(connector));
        expect(toolEvidenceChars(merged)).toBeGreaterThanOrEqual(toolEvidenceChars(span));
      }
    });

    it('fills missing toolName from the span step when shapes line up, without overriding an existing one', () => {
      const connector = [
        step({ type: 'action', content: '{}', toolName: 'search' }),
        step({ type: 'tool_result', content: 'rows: a, b, c, d, e, f, g, h', toolOutput: 'rows: a, b, c, d, e, f, g, h' }), // no toolName
        step({ type: 'response', content: 'done' }),
      ];
      const span = [
        step({ type: 'action', content: 'search', toolName: 'other_name', latencyMs: 5 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'search', latencyMs: 4 }),
      ];
      const merged = mergeSpanTrajectory(connector, span);
      expect(merged[0].toolName).toBe('search'); // existing name kept
      expect(merged[1].toolName).toBe('search'); // filled from span
      expect(merged[1].toolOutput).toBe('rows: a, b, c, d, e, f, g, h');
    });

    it('does not fold timing when the tool sequences differ in shape (counts/types mismatch)', () => {
      const connector = restConnectorTrajectory();
      const span = [
        step({ type: 'action', content: 'x', toolName: 'x', latencyMs: 1 }),
        step({ type: 'action', content: 'y', toolName: 'y', latencyMs: 2 }),
        step({ type: 'action', content: 'z', toolName: 'z', latencyMs: 3 }),
      ];
      const merged = mergeSpanTrajectory(connector, span);
      expect(merged).toEqual(connector);
      expect(merged.every((s) => s.latencyMs === undefined)).toBe(true);
    });

    it('uses the span trajectory when it is at least as complete (trace-only agent, #320) and appends the connector answer when spans have no response', () => {
      const connector = [step({ type: 'response', content: 'Final answer only (AG-UI)' })];
      const span = [
        step({ type: 'action', content: '{"product_id":"PROD-001"}', toolName: 'add_to_cart' }),
        step({ type: 'tool_result', content: '{"cart_total":79.99}', toolName: 'add_to_cart', toolOutput: '{"cart_total":79.99}' }),
      ];
      const merged = mergeSpanTrajectory(connector, span);
      expect(merged.slice(0, 2)).toEqual(span);
      expect(merged.at(-1)).toMatchObject({ type: 'response', content: 'Final answer only (AG-UI)' });
    });

    it('uses the span trajectory as-is when it already carries a non-empty response', () => {
      const connector = [
        step({ type: 'assistant', content: 'partial' }),
        step({ type: 'response', content: 'connector answer' }),
      ];
      const span = [
        step({ type: 'action', content: 'a', toolName: 't' }),
        step({ type: 'tool_result', content: 'r', toolName: 't', toolOutput: 'r' }),
        step({ type: 'response', content: 'span answer' }),
      ];
      expect(mergeSpanTrajectory(connector, span)).toEqual(span);
    });

    it('appends the span answer when the connector had evidence but no response text (symmetry)', () => {
      const connector = [
        step({ type: 'action', content: 'a', toolName: 't' }),
        step({ type: 'tool_result', content: 'r', toolName: 't', toolOutput: 'r' }),
      ];
      const span = [step({ type: 'response', content: 'span answer' })];
      const merged = mergeSpanTrajectory(connector, span);
      expect(merged.slice(0, 2)).toEqual(connector);
      expect(merged.at(-1)).toMatchObject({ type: 'response', content: 'span answer' });
    });

    it('does not mutate its inputs', () => {
      const connector = restConnectorTrajectory();
      const span = [
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 120 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 118 }),
        step({ type: 'action', content: 'dsl_executor', toolName: 'dsl_executor', latencyMs: 40 }),
        step({ type: 'tool_result', content: 'tool succeeded', toolName: 'dsl_executor', latencyMs: 39 }),
      ];
      const connectorCopy = JSON.parse(JSON.stringify(connector));
      const spanCopy = JSON.parse(JSON.stringify(span));
      mergeSpanTrajectory(connector, span);
      expect(connector).toEqual(connectorCopy);
      expect(span).toEqual(spanCopy);
    });
  });
});
