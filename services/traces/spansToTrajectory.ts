/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spans → Trajectory adapter (for the `profile` command).
 *
 * Converts a live coding-agent session's OTel spans into the same
 * `TrajectoryStep[]` shape the evaluation/judge pipeline already consumes, so a
 * real session can be analyzed with the very evaluator a customer uses on
 * synthetic evals — no separate runtime, same `improvementStrategies[]` schema.
 *
 * Two span shapes are handled:
 *   - **Claude Code native** — content lives in span *attributes* keyed by
 *     `span.type` (`interaction`, `tool`, `tool.execution`, `llm_request`,
 *     `tool.blocked_on_user`). This is what real `claude_code.*` telemetry
 *     emits; verified against a live cluster.
 *   - **Generic / event-based** — OTel GenAI `llm.request`/`tool` spans with
 *     events, via the shared `extractMessagesFromSpans` helper.
 *
 * Also runs a cheap, deterministic "signal scan" so the downstream reasoner
 * (the in-session coding agent, or a headless judge) gets structured evidence
 * instead of re-deriving it from raw spans.
 */

import { Span, TrajectoryStep, ToolCallStatus } from '@/types';
import { extractMessagesFromSpans } from './messageExtraction';

export interface SessionSignal {
  id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  evidence: string;
}

/** Tool names (case-insensitive substrings) we treat as state-mutating. */
const WRITE_TOOL_HINTS = ['write', 'edit', 'apply', 'create', 'delete', 'patch', 'replace', 'multiedit', 'notebookedit'];
/** Tool names we treat as read-only inspection. */
const READ_TOOL_HINTS = ['read', 'get', 'list', 'search', 'grep', 'glob', 'find', 'cat', 'view', 'fetch', 'ls'];
/** Phrases that signal a human correcting/redirecting the agent. */
const REDIRECT_PATTERNS = [
  /\bno[,.\s]/i, /\bactually\b/i, /\bwrong\b/i, /\bnot (?:that|right|correct)\b/i,
  /\binstead\b/i, /\bstop\b/i, /\bdon'?t\b/i, /\bthat'?s not\b/i, /\btry (?:x|again|something)\b/i,
];

function classifyTool(name: string | undefined): 'write' | 'read' | 'other' {
  if (!name) return 'other';
  const n = name.toLowerCase();
  if (WRITE_TOOL_HINTS.some(h => n.includes(h))) return 'write';
  if (READ_TOOL_HINTS.some(h => n.includes(h))) return 'read';
  return 'other';
}

function truncate(s: string, max = 240): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Is this a Claude Code native span set (attribute-based, no useful events)? */
function isClaudeNative(spans: Span[]): boolean {
  return spans.some(s =>
    s.name?.startsWith('claude_code.') || s.attributes?.['span.type'] !== undefined
  );
}

/** Resolve a span's claude `span.type` (e.g. `tool.execution`). */
function spanType(s: Span): string {
  return String(s.attributes?.['span.type'] ?? s.name?.replace(/^claude_code\./, '') ?? '');
}

function sortByStart(spans: Span[]): Span[] {
  return [...spans]
    .filter(s => s.startTime && !isNaN(new Date(s.startTime).getTime()))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/** Map tool_use_id → tool_name from the `tool` (call) spans. */
function toolNamesById(spans: Span[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of spans) {
    const a = s.attributes || {};
    const id = a['tool_use_id'] || a['gen_ai.tool.call.id'];
    const name = a['tool_name'] || a['gen_ai.tool.name'];
    if (id && name) m.set(String(id), String(name));
  }
  return m;
}

// ─── Claude Code native path ─────────────────────────────────────────────────

function claudeNativeTrajectory(spans: Span[]): TrajectoryStep[] {
  const sorted = sortByStart(spans);
  const toolNames = toolNamesById(sorted);
  const steps: TrajectoryStep[] = [];

  for (const s of sorted) {
    const a = s.attributes || {};
    const ts = new Date(s.startTime).getTime() || Date.now();
    const base = { id: s.spanId, timestamp: ts, latencyMs: Number(a['duration_ms']) || s.duration };
    const t = spanType(s);

    if (t === 'interaction') {
      const prompt = a['user_prompt'];
      const redacted = !prompt || prompt === '<REDACTED>';
      steps.push({
        ...base,
        type: 'thinking',
        content: redacted
          ? `User: [prompt redacted — set OTEL_LOG_USER_PROMPTS=1 to capture] (${a['user_prompt_length'] ?? '?'} chars)`
          : `User: ${prompt}`,
      });
    } else if (t === 'llm_request') {
      const model = a['model'] || a['gen_ai.request.model'] || '';
      const stop = a['stop_reason'] || a['gen_ai.response.finish_reasons'] || '';
      steps.push({
        ...base,
        type: 'assistant',
        content: `[LLM ${model}${stop ? ` · stop=${Array.isArray(stop) ? stop.join(',') : stop}` : ''}]`,
      });
    } else if (t === 'tool') {
      const name = a['tool_name'] || a['gen_ai.tool.name'];
      const input = a['tool_input'] || a['gen_ai.tool.input'];
      let toolArgs: Record<string, any> | undefined;
      if (input) { try { toolArgs = typeof input === 'string' ? JSON.parse(input) : input; } catch { /* raw */ } }
      steps.push({
        ...base,
        type: 'action',
        content: input ? (typeof input === 'string' ? input : JSON.stringify(input)) : String(name ?? ''),
        toolName: name ? String(name) : undefined,
        toolArgs,
      });
    } else if (t === 'tool.execution') {
      const success = a['success'];
      const id = a['tool_use_id'] || a['gen_ai.tool.call.id'];
      const name = (id && toolNames.get(String(id))) || a['tool_name'];
      const output = a['gen_ai.tool.output'] || a['tool.output'];
      steps.push({
        ...base,
        type: 'tool_result',
        content: output != null ? String(output) : (success === false ? 'tool failed' : 'tool succeeded'),
        toolName: name ? String(name) : undefined,
        toolOutput: output,
        status: success === false ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS,
      });
    } else if (t === 'tool.blocked_on_user') {
      const decision = String(a['decision'] ?? '');
      if (decision && decision !== 'accept') {
        steps.push({ ...base, type: 'thinking', content: `User ${decision}ed a tool call (${a['source'] ?? ''})` });
      }
    }
  }
  return steps;
}

function claudeNativeSignals(spans: Span[]): SessionSignal[] {
  const sorted = sortByStart(spans);
  const toolNames = toolNamesById(sorted);
  const signals: SessionSignal[] = [];

  // user_rejection — explicit permission denial (always available, no prompt logging needed).
  const rejections = sorted.filter(s =>
    spanType(s) === 'tool.blocked_on_user' && String(s.attributes?.['decision'] ?? '') !== 'accept'
      && s.attributes?.['decision'] !== undefined
  );
  if (rejections.length > 0) {
    signals.push({
      id: 'user_rejection',
      title: 'User rejected/aborted a tool the agent proposed',
      severity: 'high',
      count: rejections.length,
      evidence: truncate(rejections.map(r => `${r.attributes?.['decision']} (${r.attributes?.['source'] ?? '?'})`).join(', ')),
    });
  }

  // user_redirect — a correction prompt AFTER the agent has acted (only when
  // prompts are logged; else <REDACTED>). Gate on a prior agent span so multiple
  // opening prompts before the agent responds don't count as redirects (matches
  // the generic path's sawAgentTurn gating).
  const redirects: string[] = [];
  let sawAgentSpan = false;
  for (const s of sorted) {
    const t = spanType(s);
    if (t === 'llm_request' || t === 'tool' || t === 'tool.execution') { sawAgentSpan = true; continue; }
    if (t === 'interaction') {
      const p = String(s.attributes?.['user_prompt'] ?? '');
      if (sawAgentSpan && p && p !== '<REDACTED>' && REDIRECT_PATTERNS.some(re => re.test(p))) redirects.push(p);
    }
  }
  if (redirects.length > 0) {
    signals.push({
      id: 'user_redirect',
      title: 'User corrected/redirected the agent mid-session',
      severity: 'high',
      count: redirects.length,
      evidence: truncate(redirects.map(r => `"${r}"`).join(' · ')),
    });
  }

  // tool_error_retry — a failed tool.execution followed by another call to the same tool.
  const ordered = sorted.map(s => ({ t: spanType(s), a: s.attributes || {} }));
  let retries = 0; let retryEvidence = '';
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    if (cur.t !== 'tool.execution' || cur.a['success'] !== false) continue;
    const id = cur.a['tool_use_id'] || cur.a['gen_ai.tool.call.id'];
    const name = (id && toolNames.get(String(id))) || cur.a['tool_name'];
    if (!name) continue;
    const laterSame = ordered.slice(i + 1).some(o =>
      o.t === 'tool' && (o.a['tool_name'] === name || o.a['gen_ai.tool.name'] === name)
    );
    if (laterSame) { retries++; if (!retryEvidence) retryEvidence = String(name); }
  }
  if (retries > 0) {
    signals.push({
      id: 'tool_error_retry',
      title: 'Tool failed, then was retried — likely a tool-usage / description gap',
      severity: 'high',
      count: retries,
      evidence: retryEvidence,
    });
  }

  // repeated_tool_calls — identical tool + args invoked more than once. Only
  // groups when tool_input is present (native tool spans often omit it); without
  // args each call is keyed by its spanId so legitimately-repeated tools (e.g.
  // many distinct Bash calls) don't false-positive.
  const repeatSeen = new Map<string, number>();
  for (const s of sorted) {
    if (spanType(s) !== 'tool') continue;
    const a = s.attributes || {};
    const name = String(a['tool_name'] ?? a['gen_ai.tool.name'] ?? '?');
    const input = a['tool_input'] ?? a['gen_ai.tool.input'];
    const key = input != null && input !== ''
      ? `${name}::${typeof input === 'string' ? input : JSON.stringify(input)}`
      : `${name}::__unique-${s.spanId}`;
    repeatSeen.set(key, (repeatSeen.get(key) ?? 0) + 1);
  }
  const repeated = [...repeatSeen.entries()].filter(([, n]) => n > 1);
  if (repeated.length > 0) {
    signals.push({
      id: 'repeated_tool_calls',
      title: 'Agent repeated identical tool calls (possible loop / distrust of output)',
      severity: 'medium',
      count: repeated.reduce((acc, [, n]) => acc + (n - 1), 0),
      evidence: truncate(repeated.map(([k, n]) => `${k.split('::')[0]} ×${n}`).join(', ')),
    });
  }

  // write_before_read — a mutating tool ran before any read/inspect tool.
  const toolCalls = sorted.filter(s => spanType(s) === 'tool')
    .map(s => String(s.attributes?.['tool_name'] ?? s.attributes?.['gen_ai.tool.name'] ?? ''));
  const firstWrite = toolCalls.findIndex(n => classifyTool(n) === 'write');
  const firstRead = toolCalls.findIndex(n => classifyTool(n) === 'read');
  if (firstWrite !== -1 && (firstRead === -1 || firstWrite < firstRead)) {
    signals.push({
      id: 'write_before_read',
      title: 'Agent mutated state before reading — possible safety / grounding gap',
      severity: 'high',
      count: 1,
      evidence: `first write: ${toolCalls[firstWrite]}`,
    });
  }

  // long_session — interaction count.
  const interactions = sorted.filter(s => spanType(s) === 'interaction').length;
  if (interactions > 20) {
    signals.push({
      id: 'long_session',
      title: `Long session (${interactions} interactions) — possible confusion or scope creep`,
      severity: 'low',
      count: interactions,
      evidence: `${interactions} interactions, ${toolCalls.length} tool calls`,
    });
  }

  return signals;
}

// ─── Generic / event-based path ──────────────────────────────────────────────

function genericTrajectory(spans: Span[], serviceName?: string): TrajectoryStep[] {
  const messages = extractMessagesFromSpans(spans, serviceName);
  const erroredSpanIds = new Set(spans.filter(s => s.status === 'ERROR').map(s => s.spanId));
  const steps: TrajectoryStep[] = [];
  for (const m of messages) {
    const ts = new Date(m.timestamp).getTime() || Date.now();
    const base = { id: m.id, timestamp: ts, latencyMs: m.metadata?.durationMs };
    switch (m.role) {
      case 'assistant':
        steps.push({ ...base, type: 'assistant', content: m.content }); break;
      case 'tool_call': {
        let toolArgs: Record<string, any> | undefined;
        try { toolArgs = m.content ? JSON.parse(m.content) : undefined; } catch { /* raw */ }
        steps.push({ ...base, type: 'action', content: m.content, toolName: m.metadata?.toolName, toolArgs }); break;
      }
      case 'tool_result': {
        const errored = m.metadata?.spanId ? erroredSpanIds.has(m.metadata.spanId) : false;
        steps.push({
          ...base, type: 'tool_result', content: m.content, toolName: m.metadata?.toolName,
          toolOutput: m.content, status: errored ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS,
        }); break;
      }
      case 'user':
        steps.push({ ...base, type: 'thinking', content: `User: ${m.content}` }); break;
      default:
        steps.push({ ...base, type: 'thinking', content: m.content });
    }
  }
  return steps;
}

function genericSignals(spans: Span[], serviceName?: string): SessionSignal[] {
  const messages = extractMessagesFromSpans(spans, serviceName);
  // Span ids that errored, so tool_error_retry can key off real span status
  // rather than scraping the result text for words like "error".
  const erroredSpanIds = new Set(spans.filter(s => s.status === 'ERROR').map(s => s.spanId));
  const signals: SessionSignal[] = [];

  let sawAgentTurn = false;
  const redirects: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' || m.role === 'tool_call' || m.role === 'tool_result') sawAgentTurn = true;
    else if (m.role === 'user' && sawAgentTurn && REDIRECT_PATTERNS.some(re => re.test(m.content))) redirects.push(m.content);
  }
  if (redirects.length > 0) {
    signals.push({ id: 'user_redirect', title: 'User corrected / redirected the agent mid-session', severity: 'high', count: redirects.length, evidence: truncate(redirects.map(r => `"${r}"`).join(' · ')) });
  }

  const toolCalls = messages.filter(m => m.role === 'tool_call');

  let retries = 0; let retryEvidence = '';
  for (let i = 0; i < messages.length - 1; i++) {
    const cur = messages[i];
    if (cur.role !== 'tool_result') continue;
    // Primary signal: the underlying span errored. Fall back to a content
    // heuristic only when the result has no span id to check.
    const spanId = cur.metadata?.spanId;
    const errored = spanId
      ? erroredSpanIds.has(spanId)
      : /error|failed|exception|not found|denied/i.test(cur.content);
    if (!errored) continue;
    const tool = cur.metadata?.toolName;
    if (tool && messages.slice(i + 1).some(m => m.role === 'tool_call' && m.metadata?.toolName === tool)) {
      retries++; if (!retryEvidence) retryEvidence = `${tool}: ${truncate(cur.content, 120)}`;
    }
  }
  if (retries > 0) {
    signals.push({ id: 'tool_error_retry', title: 'Tool failed, then was retried — likely a tool-usage / description gap', severity: 'high', count: retries, evidence: retryEvidence });
  }

  const seen = new Map<string, number>();
  for (const tc of toolCalls) {
    const key = `${tc.metadata?.toolName ?? '?'}::${tc.content}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  if (repeated.length > 0) {
    signals.push({ id: 'repeated_tool_calls', title: 'Agent repeated identical tool calls (possible loop / distrust of output)', severity: 'medium', count: repeated.reduce((acc, [, n]) => acc + (n - 1), 0), evidence: truncate(repeated.map(([k, n]) => `${k.split('::')[0]} ×${n}`).join(', ')) });
  }

  const turns = messages.filter(m => m.role === 'assistant' || m.role === 'user').length;
  if (turns > 20) {
    signals.push({ id: 'long_session', title: `Long session (${turns} turns) — possible confusion or scope creep`, severity: 'low', count: turns, evidence: `${turns} conversational turns, ${toolCalls.length} tool calls` });
  }

  const firstWriteIdx = toolCalls.findIndex(tc => classifyTool(tc.metadata?.toolName) === 'write');
  const firstReadIdx = toolCalls.findIndex(tc => classifyTool(tc.metadata?.toolName) === 'read');
  if (firstWriteIdx !== -1 && (firstReadIdx === -1 || firstWriteIdx < firstReadIdx)) {
    signals.push({ id: 'write_before_read', title: 'Agent mutated state before reading — possible safety / grounding gap', severity: 'high', count: 1, evidence: `first write: ${toolCalls[firstWriteIdx].metadata?.toolName ?? '?'}` });
  }

  return signals;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Convert session spans into a chronological `TrajectoryStep[]`. */
export function spansToTrajectory(spans: Span[], serviceName?: string): TrajectoryStep[] {
  if (!spans || spans.length === 0) return [];
  return isClaudeNative(spans) ? claudeNativeTrajectory(spans) : genericTrajectory(spans, serviceName);
}

/**
 * Cheap, deterministic signal scan. Empty result ⇒ nothing notable happened
 * (caller may skip the LLM).
 */
export function scanSessionSignals(spans: Span[], serviceName?: string): SessionSignal[] {
  if (!spans || spans.length === 0) return [];
  return isClaudeNative(spans) ? claudeNativeSignals(spans) : genericSignals(spans, serviceName);
}
