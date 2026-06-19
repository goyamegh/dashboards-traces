/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildProfile } from '@/services/profile/buildProfile';
import type { Evaluator, Span } from '@/types';

// Minimal Claude Code-native span (attribute-based telemetry shape), mirroring
// the fixtures in tests/unit/services/traces/spansToTrajectory.test.ts.
function ccSpan(
  spanId: string,
  type: string,
  attrs: Record<string, any>,
  time: string,
  status: 'OK' | 'ERROR' | 'UNSET' = 'UNSET',
): Span {
  return {
    traceId: 't1',
    spanId,
    name: `claude_code.${type}`,
    startTime: time,
    endTime: time,
    status,
    attributes: {
      'service.name': 'claude-code-agent',
      serviceName: 'claude-code-agent',
      'span.type': type,
      'session.id': 'sess-1',
      ...attrs,
    },
  };
}

const EVALUATOR: Evaluator = {
  id: 'system-rca-default',
  name: 'RCA Default',
  systemPrompt: 'You are a root-cause analysis rubric.',
  scoringConfig: {
    metrics: [{ name: 'correctness', weight: 1 } as any],
    passThreshold: 70,
  },
} as Evaluator;

describe('buildProfile', () => {
  it('assembles a complete profile from spans + evaluator', () => {
    const spans: Span[] = [
      ccSpan('s1', 'tool.decision', { tool_name: 'Read', decision: 'accept' }, '2026-01-01T00:00:00.000Z', 'OK'),
      ccSpan('s2', 'tool.decision', { tool_name: 'Edit', decision: 'accept' }, '2026-01-01T00:00:02.000Z', 'OK'),
    ];

    const profile = buildProfile('sess-1', spans, EVALUATOR);

    expect(profile.session.sessionId).toBe('sess-1');
    expect(profile.session.serviceName).toBe('claude-code-agent');
    expect(profile.session.spanCount).toBe(2);
    expect(profile.session.traceIds).toEqual(['t1']);
    expect(profile.evaluator.id).toBe('system-rca-default');
    expect(profile.evaluator.systemPrompt).toContain('root-cause');
    expect(Array.isArray(profile.signals)).toBe(true);
    expect(Array.isArray(profile.trajectory)).toBe(true);
    expect(profile.instructions).toContain('improving the agent');
  });

  it('computes duration from span start/end extents', () => {
    const spans: Span[] = [
      { traceId: 't1', spanId: 'a', name: 'x', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.000Z', status: 'OK', attributes: { 'service.name': 'claude-code' } },
      { traceId: 't1', spanId: 'b', name: 'y', startTime: '2026-01-01T00:00:02.000Z', endTime: '2026-01-01T00:00:05.000Z', status: 'OK', attributes: { 'service.name': 'claude-code' } },
    ];
    const profile = buildProfile('sess-1', spans, EVALUATOR);
    // earliest start 00:00 → latest end 00:05 = 5000ms
    expect(profile.session.durationMs).toBe(5000);
  });

  it('sums tokens across both gen_ai.* and bare attribute keys', () => {
    const spans: Span[] = [
      { traceId: 't1', spanId: 'a', name: 'chat', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.000Z', status: 'OK', attributes: { 'service.name': 'claude-code', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50 } },
      { traceId: 't1', spanId: 'b', name: 'chat', startTime: '2026-01-01T00:00:01.000Z', endTime: '2026-01-01T00:00:02.000Z', status: 'OK', attributes: { 'service.name': 'claude-code', input_tokens: '10', output_tokens: '5' } },
    ];
    const profile = buildProfile('sess-1', spans, EVALUATOR);
    expect(profile.session.tokens).toBe(165);
  });

  it('threads userFeedback into the profile and instruction block', () => {
    const spans: Span[] = [ccSpan('s1', 'tool.decision', { tool_name: 'Read' }, '2026-01-01T00:00:00.000Z')];
    const profile = buildProfile('sess-1', spans, EVALUATOR, { userFeedback: 'focus on routing; it ignored the SOP' });
    expect(profile.userFeedback).toBe('focus on routing; it ignored the SOP');
    expect(profile.instructions).toContain('PRIMARY lens');
    expect(profile.instructions).toContain('focus on routing');
  });

  it('omits userFeedback and uses the rubric-only instruction when no feedback given', () => {
    const spans: Span[] = [ccSpan('s1', 'tool.decision', { tool_name: 'Read' }, '2026-01-01T00:00:00.000Z')];
    const profile = buildProfile('sess-1', spans, EVALUATOR);
    expect(profile.userFeedback).toBeUndefined();
    expect(profile.instructions).toContain('No upfront user feedback');
  });

  it('is deterministic — same inputs produce a byte-identical profile (CLI === API guarantee)', () => {
    const spans: Span[] = [
      ccSpan('s1', 'tool.decision', { tool_name: 'Read', decision: 'accept' }, '2026-01-01T00:00:00.000Z', 'OK'),
      ccSpan('s2', 'tool.decision', { tool_name: 'Edit', decision: 'accept' }, '2026-01-01T00:00:02.000Z', 'OK'),
    ];
    const a = buildProfile('sess-1', spans, EVALUATOR, { userFeedback: 'x' });
    const b = buildProfile('sess-1', spans, EVALUATOR, { userFeedback: 'x' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reports observed service name from spans, preferring service.name attribute', () => {
    const spans: Span[] = [
      { traceId: 't1', spanId: 'a', name: 'x', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.000Z', status: 'OK', attributes: { 'service.name': 'claude-code' } },
    ];
    const profile = buildProfile('sess-1', spans, EVALUATOR, { service: 'fallback-service' });
    expect(profile.session.serviceName).toBe('claude-code');
  });
});
