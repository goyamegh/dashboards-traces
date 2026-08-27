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

  it('gates user_redirect on a prior agent span (no false positive on opening prompts)', () => {
    // Two user prompts before any agent span — must NOT flag a redirect.
    const before: Span[] = [
      ccSpan('i1', 'interaction', { user_prompt: 'do the thing' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('i2', 'interaction', { user_prompt: 'no, the other thing' }, '2026-01-01T00:00:01.000Z'),
    ];
    expect(scanSessionSignals(before).find(s => s.id === 'user_redirect')).toBeUndefined();
    // Same redirect phrase AFTER an agent span — must flag.
    const after: Span[] = [
      ccSpan('i1', 'interaction', { user_prompt: 'do the thing' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('l1', 'llm_request', { model: 'claude', stop_reason: 'end_turn' }, '2026-01-01T00:00:01.000Z'),
      ccSpan('i2', 'interaction', { user_prompt: 'no, that is wrong' }, '2026-01-01T00:00:02.000Z'),
    ];
    expect(scanSessionSignals(after).find(s => s.id === 'user_redirect')).toBeDefined();
  });

  it('does NOT match "no right" as a redirect (regex requires "not")', () => {
    const clean: Span[] = [
      ccSpan('l1', 'llm_request', { model: 'claude' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('i1', 'interaction', { user_prompt: 'annotate the rightmost correct column' }, '2026-01-01T00:00:01.000Z'),
    ];
    // After the `not?`→`not` fix, neither "right" nor "correct" (without a
    // preceding "not") trips the redirect pattern.
    expect(scanSessionSignals(clean).find(s => s.id === 'user_redirect')).toBeUndefined();
  });

  it('emits a tool_result from a `tool` span\'s own tool.output event (no separate tool.execution span)', () => {
    const spans: Span[] = [
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.500Z', attributes: { output: 'file contents' } }],
      },
    ];
    const traj = spansToTrajectory(spans);
    expect(traj.map(t => t.type)).toEqual(['action', 'tool_result']);
    const result = traj[1];
    expect(result.toolName).toBe('Bash');
    expect(result.content).toBe('file contents');
    expect(result.toolOutput).toBe('file contents');
    expect(result.status).toBe(ToolCallStatus.SUCCESS);
    // Ordered by the event's own timestamp, not the tool span's start time.
    expect(result.timestamp).toBe(new Date('2026-01-01T00:00:01.500Z').getTime());
  });

  it('marks a tool.output-event result FAILURE when the tool span itself errored', () => {
    const spans: Span[] = [
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
        status: 'ERROR',
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'boom' } }],
      },
    ];
    const result = spansToTrajectory(spans).find(t => t.type === 'tool_result')!;
    expect(result.status).toBe(ToolCallStatus.FAILURE);
  });

  it('reads output from the `result` event attribute when `output` is absent', () => {
    const spans: Span[] = [
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Grep', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { result: 'match found' } }],
      },
    ];
    const result = spansToTrajectory(spans).find(t => t.type === 'tool_result')!;
    expect(result.content).toBe('match found');
  });

  it('does NOT emit a tool_result when the tool span has no tool.output event (unchanged fallback behavior)', () => {
    const spans: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
    ];
    const traj = spansToTrajectory(spans);
    expect(traj.map(t => t.type)).toEqual(['action']);
  });

  it('does NOT emit a tool_result when the tool.output event carries no usable output/result', () => {
    const spans: Span[] = [
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: {} }],
      },
    ];
    const traj = spansToTrajectory(spans);
    expect(traj.map(t => t.type)).toEqual(['action']);
  });

  it('dedupes: a tool span with a tool.output event plus a sibling tool.execution span → only one tool_result', () => {
    const spans: Span[] = [
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'from event' } }],
      },
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: true, 'gen_ai.tool.output': 'from execution attrs' }, '2026-01-01T00:00:02.000Z'),
    ];
    const traj = spansToTrajectory(spans);
    const results = traj.filter(t => t.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from event'); // event-based result wins, execution's is skipped
  });

  it('dedupes even when the tool.execution span sorts BEFORE the tool span (clock skew / out-of-order spans)', () => {
    const spans: Span[] = [
      // tool.execution has an earlier startTime than its own `tool` call —
      // an unusual but possible ordering (clock skew across processes). The
      // dedup Set must be checked/marked symmetrically by both branches so
      // whichever one is processed first "wins", regardless of which span
      // shape that happens to be.
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: true, 'gen_ai.tool.output': 'from execution attrs' }, '2026-01-01T00:00:00.000Z'),
      {
        ...ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.500Z'),
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'from event' } }],
      },
    ];
    const traj = spansToTrajectory(spans);
    const results = traj.filter(t => t.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from execution attrs'); // execution processed first (earlier startTime), wins
  });

  it('still emits from tool.execution when its sibling tool span has no tool.output event', () => {
    const spans: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'tu1' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('e1', 'tool.execution', { tool_use_id: 'tu1', success: true, 'gen_ai.tool.output': 'from execution attrs' }, '2026-01-01T00:00:01.000Z'),
    ];
    const traj = spansToTrajectory(spans);
    const results = traj.filter(t => t.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from execution attrs');
  });

  it('detects native repeated_tool_calls only when args are identical', () => {
    const repeated: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'grep', tool_input: '{"q":"foo"}', tool_use_id: 'a' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('t2', 'tool', { tool_name: 'grep', tool_input: '{"q":"foo"}', tool_use_id: 'b' }, '2026-01-01T00:00:01.000Z'),
    ];
    const sig = scanSessionSignals(repeated).find(s => s.id === 'repeated_tool_calls');
    expect(sig).toBeDefined();
    expect(sig!.count).toBe(1);
    // Same tool, NO args — must not group (each call unique by spanId).
    const noArgs: Span[] = [
      ccSpan('t1', 'tool', { tool_name: 'Bash', tool_use_id: 'a' }, '2026-01-01T00:00:00.000Z'),
      ccSpan('t2', 'tool', { tool_name: 'Bash', tool_use_id: 'b' }, '2026-01-01T00:00:01.000Z'),
    ];
    expect(scanSessionSignals(noArgs).find(s => s.id === 'repeated_tool_calls')).toBeUndefined();
  });
});
