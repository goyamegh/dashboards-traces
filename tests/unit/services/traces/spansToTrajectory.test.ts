/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { spansToTrajectory, scanSessionSignals } from '@/services/traces/spansToTrajectory';
import { Span, ToolCallStatus } from '@/types';

// ─── Claude Code native spans (attribute-based — the real telemetry shape) ───

function ccSpan(spanId: string, type: string, attrs: Record<string, any>, time: string, status: 'OK' | 'ERROR' | 'UNSET' = 'UNSET'): Span {
  return {
    traceId: 't1',
    spanId,
    name: `claude_code.${type}`,
    startTime: time,
    endTime: time,
    status,
    attributes: { 'service.name': 'claude-code-agent', serviceName: 'claude-code-agent', 'span.type': type, 'session.id': 'sess-1', ...attrs },
  };
}

/** Build a Claude Code-style span with events. */
function span(partial: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 't1',
    name: 'interaction',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    status: 'OK',
    attributes: { 'service.name': 'claude-code' },
    ...partial,
  };
}

function userPrompt(spanId: string, text: string, time: string): Span {
  return span({
    spanId,
    name: 'interaction',
    startTime: time,
    endTime: time,
    events: [{ name: 'user_prompt', time, attributes: { 'user.prompt': text } }],
  });
}

function toolCall(spanId: string, tool: string, input: string, time: string, status: 'OK' | 'ERROR' = 'OK'): Span {
  return span({
    spanId,
    name: 'tool',
    startTime: time,
    endTime: time,
    status,
    attributes: { 'service.name': 'claude-code', tool_name: tool, tool_input: input },
    events: [{ name: 'tool_decision', time, attributes: { input } }],
  });
}

function toolResult(spanId: string, tool: string, output: string, time: string, status: 'OK' | 'ERROR' = 'OK'): Span {
  return span({
    spanId,
    name: 'tool.execution',
    startTime: time,
    endTime: time,
    status,
    attributes: { 'service.name': 'claude-code', tool_name: tool, 'tool.output': output },
    events: [{ name: 'tool_result', time, attributes: { result: output } }],
  });
}

describe('spansToTrajectory', () => {
  it('maps user / tool_call / tool_result roles to TrajectoryStep types', () => {
    const spans: Span[] = [
      userPrompt('s1', 'fix the bug', '2026-01-01T00:00:00.000Z'),
      toolCall('s2', 'read_file', '{"path":"a.ts"}', '2026-01-01T00:00:01.000Z'),
      toolResult('s3', 'read_file', 'file contents', '2026-01-01T00:00:02.000Z'),
    ];
    const traj = spansToTrajectory(spans, 'claude-code');

    const types = traj.map(t => t.type);
    expect(types).toContain('thinking');     // user prompt
    expect(types).toContain('action');       // tool call
    expect(types).toContain('tool_result');  // tool result

    const action = traj.find(t => t.type === 'action')!;
    expect(action.toolName).toBe('read_file');
    expect(action.toolArgs).toEqual({ path: 'a.ts' });

    const userStep = traj.find(t => t.content.startsWith('User:'))!;
    expect(userStep.content).toContain('fix the bug');
  });

  it('marks tool_result FAILURE when the span status is ERROR', () => {
    const spans: Span[] = [
      toolResult('s1', 'run_tests', 'boom', '2026-01-01T00:00:01.000Z', 'ERROR'),
    ];
    const traj = spansToTrajectory(spans, 'claude-code');
    const result = traj.find(t => t.type === 'tool_result')!;
    expect(result.status).toBe(ToolCallStatus.FAILURE);
  });

  it('returns an empty array for no spans', () => {
    expect(spansToTrajectory([], 'claude-code')).toEqual([]);
  });
});

describe('scanSessionSignals', () => {
  it('detects a user redirect after the agent has acted', () => {
    const spans: Span[] = [
      toolCall('s1', 'search', 'logs', '2026-01-01T00:00:00.000Z'),
      userPrompt('s2', 'No, that is wrong — try the follower node instead', '2026-01-01T00:00:01.000Z'),
    ];
    const signals = scanSessionSignals(spans, 'claude-code');
    const redirect = signals.find(s => s.id === 'user_redirect');
    expect(redirect).toBeDefined();
    expect(redirect!.severity).toBe('high');
  });

  it('detects repeated identical tool calls', () => {
    const spans: Span[] = [
      toolCall('s1', 'grep', '{"q":"foo"}', '2026-01-01T00:00:00.000Z'),
      toolCall('s2', 'grep', '{"q":"foo"}', '2026-01-01T00:00:01.000Z'),
      toolCall('s3', 'grep', '{"q":"foo"}', '2026-01-01T00:00:02.000Z'),
    ];
    const signals = scanSessionSignals(spans, 'claude-code');
    const repeated = signals.find(s => s.id === 'repeated_tool_calls');
    expect(repeated).toBeDefined();
    expect(repeated!.count).toBe(2); // 3 calls → 2 redundant
  });

  it('detects tool error followed by a retry of the same tool', () => {
    const spans: Span[] = [
      toolResult('s1', 'run_build', 'command failed: missing dep', '2026-01-01T00:00:00.000Z', 'ERROR'),
      toolCall('s2', 'run_build', '{}', '2026-01-01T00:00:01.000Z'),
    ];
    const signals = scanSessionSignals(spans, 'claude-code');
    expect(signals.find(s => s.id === 'tool_error_retry')).toBeDefined();
  });

  it('detects write-before-read', () => {
    const spans: Span[] = [
      toolCall('s1', 'write_file', '{"path":"a.ts"}', '2026-01-01T00:00:00.000Z'),
      toolCall('s2', 'read_file', '{"path":"b.ts"}', '2026-01-01T00:00:01.000Z'),
    ];
    const signals = scanSessionSignals(spans, 'claude-code');
    const wbr = signals.find(s => s.id === 'write_before_read');
    expect(wbr).toBeDefined();
    expect(wbr!.severity).toBe('high');
  });

  it('returns no signals for a clean read-only session', () => {
    const spans: Span[] = [
      userPrompt('s1', 'what does this file do?', '2026-01-01T00:00:00.000Z'),
      toolCall('s2', 'read_file', '{"path":"a.ts"}', '2026-01-01T00:00:01.000Z'),
      toolResult('s3', 'read_file', 'contents', '2026-01-01T00:00:02.000Z'),
    ];
    const signals = scanSessionSignals(spans, 'claude-code');
    expect(signals).toHaveLength(0);
  });
});

describe('Claude Code native (attribute-based) spans', () => {
  it('builds a trajectory from interaction / llm_request / tool / tool.execution', () => {
    const spans: Span[] = [
      ccSpan('i1', 'interaction', { user_prompt: '<REDACTED>', user_prompt_length: 34 }, '2026-01-01T00:00:00.000Z'),
      ccSpan('l1', 'llm_request', { model: 'claude-opus', stop_reason: 'tool_use', input_tokens: 100, output_tokens: 20 }, '2026-01-01T00:00:01.000Z'),
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:02.000Z'),
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: true }, '2026-01-01T00:00:03.000Z'),
    ];
    const traj = spansToTrajectory(spans);
    expect(traj.map(t => t.type)).toEqual(['thinking', 'assistant', 'action', 'tool_result']);
    const action = traj.find(t => t.type === 'action')!;
    expect(action.toolName).toBe('Bash');
    const result = traj.find(t => t.type === 'tool_result')!;
    expect(result.toolName).toBe('Bash');          // resolved via tool_use_id map
    expect(result.status).toBe(ToolCallStatus.SUCCESS);
    const userStep = traj[0];
    expect(userStep.content).toContain('redacted'); // <REDACTED> prompt surfaced as redacted
  });

  it('marks tool_result FAILURE from success=false', () => {
    const spans: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: false }, '2026-01-01T00:00:01.000Z'),
    ];
    const result = spansToTrajectory(spans).find(t => t.type === 'tool_result')!;
    expect(result.status).toBe(ToolCallStatus.FAILURE);
  });

  it('detects user_rejection from tool.blocked_on_user', () => {
    const spans: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Write', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('b1', 'tool.blocked_on_user', { decision: 'reject', source: 'user_temporary' }, '2026-01-01T00:00:01.000Z'),
    ];
    const signals = scanSessionSignals(spans);
    const rej = signals.find(s => s.id === 'user_rejection');
    expect(rej).toBeDefined();
    expect(rej!.severity).toBe('high');
  });

  it('does NOT flag user_rejection when the decision is accept', () => {
    const spans: Span[] = [
      ccSpan('b1', 'tool.blocked_on_user', { decision: 'accept', source: 'user_permanent' }, '2026-01-01T00:00:00.000Z'),
    ];
    expect(scanSessionSignals(spans).find(s => s.id === 'user_rejection')).toBeUndefined();
  });

  it('detects tool_error_retry across attribute-based spans', () => {
    const spans: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: false }, '2026-01-01T00:00:01.000Z'),
      ccSpan('t2', 'tool', { tool_name: 'Bash', tool_use_id: 'tu2' }, '2026-01-01T00:00:02.000Z'),
    ];
    expect(scanSessionSignals(spans).find(s => s.id === 'tool_error_retry')).toBeDefined();
  });
});
