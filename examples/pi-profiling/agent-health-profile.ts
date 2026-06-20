/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Health — pi session profiling extension (single-file, zero-dependency).
 *
 * Drop this one file into `~/.pi/agent/extensions/` (global) or
 * `.pi/extensions/` (project) and pi will auto-load it. No `npm install` — it
 * speaks OTLP/HTTP JSON over the built-in `fetch`, so there are no
 * `@opentelemetry/*` dependencies to resolve.
 *
 * Why it exists: pi has no native OpenTelemetry telemetry (unlike Claude Code's
 * CLAUDE_CODE_ENABLE_TELEMETRY), so `agent-health profile` has nothing to read
 * for a live pi session. This extension supplies that missing half — it
 * instruments the running session and registers the profiling command.
 *
 * What it does:
 *  1. Emits OTel spans for the session (root `invoke_agent pi`, one
 *     `chat <model>` span per turn with token usage + prompt/completion, and an
 *     `execute_tool <name>` span per tool call). Every span carries
 *     `session.id`; the resource carries `service.name=pi-agent`.
 *  2. Records the session id to `.pi/agent-health/current-session` so
 *     `agent-health profile` resolves it deterministically.
 *  3. Registers `/agent-health-profile -e <id> [-f "<feedback>"]`, which runs
 *     the CLI and feeds the rubric + trajectory + signals back into the chat.
 *
 * Config (env):
 *  - OTEL_EXPORTER_OTLP_ENDPOINT  where to export (default http://localhost:4001;
 *                                 `/v1/traces` is appended if missing). Point at
 *                                 Agent Health's embedded receiver (file mode),
 *                                 an OTel Collector, or an OSIS pipeline.
 *  - OTEL_SERVICE_NAME            default `pi-agent`.
 *  - OTEL_ENABLED=false           disable telemetry (command still explains how).
 *  - AGENT_HEALTH_REDACT=1        stamp redaction placeholders instead of capturing
 *                                 prompt / tool I/O.
 *  - AGENT_HEALTH_CLI             CLI invocation (default `npx @opensearch-project/agent-health`).
 *
 * See docs/skills/AGENT_PROFILE.md.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Pure, exported helpers (unit-tested; no pi/OTel imports) ────────────────

export const PI_SERVICE_NAME = 'pi-agent';
export const PI_SCOPE_NAME = 'agent-health-pi';
export const DEFAULT_ENDPOINT = 'http://localhost:4001';
export const DEFAULT_CLI = 'npx @opensearch-project/agent-health';
export const DEFAULT_EVALUATOR = 'system-rca-default';
export const REDACTED = '[redacted]';

export type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
export interface OtlpKeyValue { key: string; value: OtlpValue; }
export interface OtlpEvent { name: string; timeUnixNano: string; attributes: OtlpKeyValue[]; }
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: OtlpEvent[];
  status: { code: number };
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
export const genTraceId = () => randomHex(16); // 32 hex chars
export const genSpanId = () => randomHex(8); // 16 hex chars

/** Parse a W3C `traceparent` (`00-<trace>-<span>-<flags>`). */
export function parseTraceparent(tp?: string): { traceId: string; spanId: string } | null {
  if (!tp) return null;
  const m = tp.trim().match(/^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return m ? { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase() } : null;
}

/** Resolve the full OTLP traces URL from a base endpoint. */
export function resolveEndpoint(base?: string): string {
  const b = (base || DEFAULT_ENDPOINT).replace(/\/$/, '');
  return b.endsWith('/v1/traces') ? b : `${b}/v1/traces`;
}

/** Stable session id from pi's session file path (basename minus extension). */
export function sessionIdFromFile(file?: string | null): string | undefined {
  if (!file) return undefined;
  const base = file.split(/[\\/]/).pop() ?? file;
  const stem = base.replace(/\.[^.]+$/, '').trim();
  return stem || undefined;
}

export function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function truncate(s: unknown, max = 5000): string {
  const str = typeof s === 'string' ? s : safeStringify(s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

export function safeStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Pull plain text out of a pi assistant message `content` (string or blocks). */
export function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b): b is { type: string; text: string } =>
      !!b && (b as any).type === 'text' && typeof (b as any).text === 'string')
    .map((b) => b.text);
  return parts.length ? parts.join('\n') : undefined;
}

/** Parse `<flag> <value>` (quoted or bare) from a raw command arg string. */
export function parseFlag(args: string, flags: string[]): string | undefined {
  const names = flags.map((f) => f.replace(/^-+/, '')).join('|');
  const re = new RegExp(`(?:^|\\s)(?:-{1,2})(?:${names})\\s+("([^"]*)"|'([^']*)'|(\\S+))`);
  const m = (args || '').match(re);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/** Build the `agent-health profile …` argv (binary + args) for a pi session. */
export function buildProfileInvocation(opts: {
  cli?: string; sessionId: string; evaluator?: string; feedback?: string; service?: string;
}): { bin: string; args: string[] } {
  const [bin, ...binArgs] = (opts.cli || DEFAULT_CLI).trim().split(/\s+/);
  const args = [
    ...binArgs, 'profile',
    '-e', opts.evaluator || DEFAULT_EVALUATOR,
    '--session', opts.sessionId,
    '--service', opts.service || PI_SERVICE_NAME,
    '--output', 'json',
  ];
  if (opts.feedback) args.push('--feedback', opts.feedback);
  return { bin, args };
}

/** Extract the JSON object from CLI stdout (tolerant of leading log lines). */
export function extractJson(stdout: string): unknown | null {
  if (!stdout) return null;
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
}

function kv(attributes: Record<string, string | number | boolean>): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: typeof value === 'number'
      ? { intValue: String(value) }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { stringValue: String(value) },
  }));
}

/** Wrap finished spans into an OTLP/JSON ExportTraceServiceRequest. */
export function buildOtlpPayload(serviceName: string, spans: OtlpSpan[]) {
  return {
    resourceSpans: [{
      resource: { attributes: kv({ 'service.name': serviceName }) },
      scopeSpans: [{ scope: { name: PI_SCOPE_NAME }, spans }],
    }],
  };
}

const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export interface SpanTimes { startNs: string; endNs: string; }
export function msToNanos(ms: number): string { return `${Math.round(ms)}000000`; }

/** Root session span (`invoke_agent pi`). */
export function buildRootSpan(p: { traceId: string; spanId: string; parentSpanId?: string; sessionId: string; times: SpanTimes }): OtlpSpan {
  return {
    traceId: p.traceId, spanId: p.spanId, ...(p.parentSpanId ? { parentSpanId: p.parentSpanId } : {}),
    name: 'invoke_agent pi', kind: SPAN_KIND_SERVER,
    startTimeUnixNano: p.times.startNs, endTimeUnixNano: p.times.endNs,
    attributes: kv({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.system': 'pi', 'gen_ai.agent.name': 'pi', 'session.id': p.sessionId }),
    events: [], status: { code: STATUS_OK },
  };
}

/** Chat (LLM) span for one turn. */
export function buildChatSpan(p: {
  traceId: string; spanId: string; parentSpanId: string; sessionId: string; times: SpanTimes;
  model: string; inputTokens?: number; outputTokens?: number; userPrompt?: string; completion?: string; redact?: boolean;
}): OtlpSpan {
  const attrs: Record<string, string | number | boolean> = {
    'gen_ai.operation.name': 'chat', 'gen_ai.system': 'pi', 'gen_ai.request.model': p.model || 'unknown', 'session.id': p.sessionId,
  };
  if (typeof p.inputTokens === 'number') attrs['gen_ai.usage.input_tokens'] = p.inputTokens;
  if (typeof p.outputTokens === 'number') attrs['gen_ai.usage.output_tokens'] = p.outputTokens;
  const events: OtlpEvent[] = [];
  if (p.userPrompt != null) {
    events.push({ name: 'llm.request', timeUnixNano: p.times.startNs, attributes: kv({ 'gen_ai.prompt': p.redact ? REDACTED : truncate(p.userPrompt) }) });
  }
  if (p.completion != null) {
    events.push({ name: 'llm.response', timeUnixNano: p.times.endNs, attributes: kv({ 'llm.completion': p.redact ? REDACTED : truncate(p.completion) }) });
  }
  return {
    traceId: p.traceId, spanId: p.spanId, parentSpanId: p.parentSpanId,
    name: `chat ${p.model || 'pi'}`, kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: p.times.startNs, endTimeUnixNano: p.times.endNs,
    attributes: kv(attrs), events, status: { code: STATUS_OK },
  };
}

/** Tool execution span (`execute_tool <name>`). */
export function buildToolSpan(p: {
  traceId: string; spanId: string; parentSpanId: string; sessionId: string; times: SpanTimes;
  toolName: string; input?: unknown; output?: unknown; isError?: boolean; redact?: boolean;
}): OtlpSpan {
  const attrs: Record<string, string | number | boolean> = {
    'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': p.toolName, 'session.id': p.sessionId,
  };
  if (p.input != null) attrs['gen_ai.tool.input'] = p.redact ? REDACTED : truncate(p.input, 3000);
  if (p.output != null) attrs['gen_ai.tool.output'] = p.redact ? REDACTED : truncate(p.output, 3000);
  return {
    traceId: p.traceId, spanId: p.spanId, parentSpanId: p.parentSpanId,
    name: `execute_tool ${p.toolName}`, kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: p.times.startNs, endTimeUnixNano: p.times.endNs,
    attributes: kv(attrs), events: [], status: { code: p.isError ? STATUS_ERROR : STATUS_OK },
  };
}

// ─── The extension (I/O wiring; not unit-tested) ─────────────────────────────

const SESSION_DIR = join('.pi', 'agent-health');
const SESSION_FILE = join(SESSION_DIR, 'current-session');

export default function (pi: ExtensionAPI) {
  let sessionId: string | null = null;
  let traceId: string | null = null;
  let rootSpanId: string | null = null;
  let rootStartNs: string | null = null;
  const buffer: OtlpSpan[] = [];

  // Per-turn / per-tool scratch state.
  let turnStartMs = 0;
  let pendingUserPrompt: string | undefined;
  let firstTurnOfInvocation = false;
  let lastUsage: { inputTokens?: number; outputTokens?: number } = {};
  let lastCompletion: string | undefined;
  let lastModel = 'unknown';
  const toolStart = new Map<string, { startMs: number; toolName: string; input: unknown }>();

  const redact = process.env.AGENT_HEALTH_REDACT === '1';
  const endpoint = resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const serviceName = process.env.OTEL_SERVICE_NAME || PI_SERVICE_NAME;
  // Opt-in: only emit when an endpoint is explicitly configured, so a
  // globally-installed copy never POSTs unexpectedly for unconfigured sessions.
  const telemetryEnabled = (): boolean =>
    process.env.OTEL_ENABLED !== 'false' && !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  async function flush(): Promise<void> {
    if (!telemetryEnabled() || buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOtlpPayload(serviceName, batch)),
      });
    } catch {
      // Best-effort: drop the batch rather than block the session.
    }
  }

  function recordSessionId(id: string): void {
    try { mkdirSync(SESSION_DIR, { recursive: true }); writeFileSync(SESSION_FILE, id); } catch { /* best-effort */ }
  }

  pi.on('session_start', async (_e, ctx) => {
    sessionId = sessionIdFromFile(ctx.sessionManager.getSessionFile()) ?? null;
    if (!sessionId) return; // ephemeral session
    recordSessionId(sessionId);
    if (!telemetryEnabled()) return;

    const parent = parseTraceparent(process.env.TRACEPARENT);
    traceId = parent?.traceId ?? genTraceId();
    rootSpanId = genSpanId();
    rootStartNs = msToNanos(Date.now());
    // Root span is finalized at shutdown; record start now.
  });

  pi.on('model_select', async (event) => {
    const id = (event as { model?: { id?: string } }).model?.id;
    if (id) lastModel = String(id);
  });

  pi.on('before_agent_start', async (event) => {
    const prompt = (event as { prompt?: unknown }).prompt;
    pendingUserPrompt = typeof prompt === 'string' ? prompt : undefined;
    firstTurnOfInvocation = true;
  });

  pi.on('turn_start', async () => {
    turnStartMs = Date.now();
    lastUsage = {};
    lastCompletion = undefined;
  });

  pi.on('message_end', async (event) => {
    const msg = (event as { message?: any }).message;
    if (!msg || msg.role !== 'assistant') return;
    const usage = msg.usage || {};
    lastUsage = {
      inputTokens: numOrUndef(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens),
      outputTokens: numOrUndef(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens),
    };
    lastCompletion = extractText(msg.content);
    if (msg.model) lastModel = String(msg.model);
  });

  pi.on('turn_end', async () => {
    if (!traceId || !rootSpanId || !sessionId) return;
    buffer.push(buildChatSpan({
      traceId, spanId: genSpanId(), parentSpanId: rootSpanId, sessionId,
      times: { startNs: msToNanos(turnStartMs || Date.now()), endNs: msToNanos(Date.now()) },
      model: lastModel, inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
      userPrompt: firstTurnOfInvocation ? pendingUserPrompt : undefined, completion: lastCompletion, redact,
    }));
    firstTurnOfInvocation = false;
    await flush();
  });

  pi.on('tool_execution_start', async (event) => {
    const e = event as { toolCallId?: string; toolName?: string; args?: unknown };
    toolStart.set(String(e.toolCallId), { startMs: Date.now(), toolName: String(e.toolName ?? 'tool'), input: e.args });
  });

  pi.on('tool_execution_end', async (event) => {
    if (!traceId || !rootSpanId || !sessionId) return;
    const e = event as { toolCallId?: string; result?: unknown; isError?: boolean };
    const started = toolStart.get(String(e.toolCallId));
    toolStart.delete(String(e.toolCallId));
    buffer.push(buildToolSpan({
      traceId, spanId: genSpanId(), parentSpanId: rootSpanId, sessionId,
      times: { startNs: msToNanos(started?.startMs ?? Date.now()), endNs: msToNanos(Date.now()) },
      toolName: started?.toolName ?? 'tool', input: started?.input, output: e.result, isError: !!e.isError, redact,
    }));
    await flush();
  });

  pi.on('session_shutdown', async () => {
    if (traceId && rootSpanId && sessionId && rootStartNs) {
      buffer.push(buildRootSpan({ traceId, spanId: rootSpanId, parentSpanId: parseTraceparent(process.env.TRACEPARENT)?.spanId, sessionId, times: { startNs: rootStartNs, endNs: msToNanos(Date.now()) } }));
    }
    await flush();
  });

  pi.registerCommand('agent-health-profile', {
    description: 'Profile this pi session against an evaluator rubric and propose fixes',
    handler: async (args, ctx) => {
      const id = sessionId ?? sessionIdFromFile(ctx.sessionManager.getSessionFile());
      if (!id) {
        ctx.ui.notify('No session id (ephemeral session) — start pi without --no-session to profile.', 'warning');
        return;
      }
      if (!telemetryEnabled()) {
        ctx.ui.notify('Telemetry is off — set OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://localhost:4001 for file-mode Agent Health) and re-run the session so its traces are captured.', 'warning');
        return;
      }
      await flush(); // ensure the just-finished turns are queryable

      const { bin, args: cmdArgs } = buildProfileInvocation({
        cli: process.env.AGENT_HEALTH_CLI || DEFAULT_CLI,
        sessionId: id,
        evaluator: parseFlag(args, ['-e', '--evaluator']),
        feedback: parseFlag(args, ['-f', '--feedback']),
        service: serviceName,
      });
      ctx.ui.notify(`Profiling pi session ${id}…`, 'info');
      const result = await pi.exec(bin, cmdArgs, { timeout: 120_000 });
      if (result.code !== 0) {
        ctx.ui.notify(`profile failed (exit ${result.code}): ${truncate(result.stderr || result.stdout, 400)}`, 'error');
        return;
      }
      const profile = extractJson(result.stdout);
      if (!profile) {
        ctx.ui.notify('profile produced no JSON — is telemetry reaching the trace store?', 'error');
        return;
      }
      pi.sendUserMessage([
        'I ran `agent-health profile` on THIS pi session. Below is the JSON profile:',
        'the evaluator rubric (`evaluator.systemPrompt`), the reconstructed `trajectory`,',
        'deterministic `signals`, and my `userFeedback` (if any).',
        '',
        'Using `evaluator.systemPrompt` as the rubric, review the trajectory + signals',
        '+ THIS conversation (including any corrections I made) + the codebase here.',
        'Produce a prioritized list of concrete edits (file, change, why — cite the',
        'signal/`traceIds`, priority) and apply them on a NEW branch for review.',
        '',
        '```json',
        truncate(JSON.stringify(profile), 60_000),
        '```',
      ].join('\n'));
    },
  });
}
