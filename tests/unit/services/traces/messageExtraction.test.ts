/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractMessagesFromSpans } from '@/services/traces/messageExtraction';
import { Span } from '@/types';

function span(partial: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 't1',
    name: 'tool',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    status: 'OK',
    attributes: { 'service.name': 'claude-code' },
    ...partial,
  };
}

describe('extractMessagesFromSpans — Claude Code tool.output events', () => {
  it('emits a tool_result message from a tool span\'s tool.output event', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        name: 'tool',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'file contents' } }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    const result = messages.find(m => m.role === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.content).toBe('file contents');
    expect(result!.metadata?.toolName).toBe('Bash');
    expect(result!.timestamp).toBe('2026-01-01T00:00:01.000Z');
  });

  it('falls back to the `result` event attribute when `output` is absent', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        attributes: { 'service.name': 'claude-code', tool_name: 'Grep', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { result: 'match found' } }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.find(m => m.role === 'tool_result')?.content).toBe('match found');
  });

  it('does not emit a tool_result when there is no tool.output event (unchanged fallback)', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.some(m => m.role === 'tool_result')).toBe(false);
  });

  it('does not emit a tool_result when the tool.output event has no usable content', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: {} }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.some(m => m.role === 'tool_result')).toBe(false);
  });

  it('dedupes: a tool span with a tool.output event plus a sibling tool.execution span emits only one tool_result', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        name: 'tool',
        startTime: '2026-01-01T00:00:00.000Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'from event' } }],
      }),
      span({
        spanId: 'e1',
        name: 'tool.execution',
        startTime: '2026-01-01T00:00:02.000Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', 'gen_ai.tool.output': 'from execution attrs' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    const results = messages.filter(m => m.role === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from event');
  });

  it('dedupes even when the tool.execution span sorts BEFORE the tool span (clock skew / out-of-order spans)', () => {
    const spans: Span[] = [
      // Earlier startTime than its own `tool` call — an unusual but possible
      // ordering. Dedup must be symmetric so whichever span is processed
      // first "wins", regardless of which shape that happens to be.
      span({
        spanId: 'e1',
        name: 'tool.execution',
        startTime: '2026-01-01T00:00:00.000Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', 'gen_ai.tool.output': 'from execution attrs' },
      }),
      span({
        spanId: 't1',
        name: 'tool',
        startTime: '2026-01-01T00:00:00.500Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'from event' } }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    const results = messages.filter(m => m.role === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from execution attrs'); // execution processed first (earlier startTime), wins
  });

  it('still emits from tool.execution attrs when its sibling tool span has no tool.output event', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        name: 'tool',
        startTime: '2026-01-01T00:00:00.000Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1' },
      }),
      span({
        spanId: 'e1',
        name: 'tool.execution',
        startTime: '2026-01-01T00:00:01.000Z',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', 'gen_ai.tool.output': 'from execution attrs' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    const results = messages.filter(m => m.role === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('from execution attrs');
  });

  it('keeps a tool_call message alongside the tool_result from a tool.output event', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: '{"cmd":"ls"}' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'a.ts b.ts' } }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.map(m => m.role)).toEqual(['tool_call', 'tool_result']);
  });

  it('reads the tool input from full_command when tool_input/gen_ai.tool.input are absent', () => {
    const spans: Span[] = [
      span({
        spanId: 't1',
        attributes: { 'service.name': 'claude-code', tool_name: 'Bash', tool_use_id: 'tu1', full_command: 'ls -la' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.find(m => m.role === 'tool_call')?.content).toBe('ls -la');
  });

  it('does not treat a tool.blocked_on_user span as a tool call', () => {
    const spans: Span[] = [
      span({
        spanId: 'b1',
        name: 'tool.blocked_on_user',
        attributes: { 'service.name': 'claude-code', decision: 'reject' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.some(m => m.role === 'tool_call')).toBe(false);
  });
});

describe('extractMessagesFromSpans — Claude Code detection + user prompt attribute', () => {
  it('extracts the user prompt directly from an interaction span attribute', () => {
    const spans: Span[] = [
      span({
        spanId: 'i1',
        name: 'interaction',
        attributes: { 'service.name': 'claude-code', user_prompt: 'fix the failing test' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    const user = messages.find(m => m.role === 'user');
    expect(user?.content).toBe('fix the failing test');
    expect(user?.id).toBe('i1-user-prompt');
  });

  it('does not surface a redacted user_prompt attribute as a message', () => {
    const spans: Span[] = [
      span({
        spanId: 'i1',
        name: 'interaction',
        attributes: { 'service.name': 'claude-code', user_prompt: '<REDACTED>' },
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.some(m => m.role === 'user')).toBe(false);
  });

  it('does not double-push a user-prompt-event message when the attribute-based one already exists', () => {
    const spans: Span[] = [
      span({
        spanId: 'i1',
        name: 'interaction',
        attributes: { 'service.name': 'claude-code', user_prompt: 'do the thing' },
        events: [{ name: 'user_prompt', time: '2026-01-01T00:00:00.000Z', attributes: { 'user.prompt': 'do the thing' } }],
      }),
    ];
    const messages = extractMessagesFromSpans(spans, 'claude-code');
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('detects Claude Code via span-name prefix alone (no service.name attribute, no serviceName arg)', () => {
    const spans: Span[] = [
      {
        traceId: 't1',
        spanId: 't1',
        name: 'claude_code.tool',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:00:01.000Z',
        status: 'OK',
        attributes: { tool_name: 'Bash', tool_use_id: 'tu1' },
        events: [{ name: 'tool.output', time: '2026-01-01T00:00:01.000Z', attributes: { output: 'ok' } }],
      },
    ];
    // No serviceName argument, and no `service.name` attribute — only the
    // `claude_code.` span-name prefix identifies this as Claude Code telemetry.
    const messages = extractMessagesFromSpans(spans);
    expect(messages.find(m => m.role === 'tool_result')?.content).toBe('ok');
  });
});
