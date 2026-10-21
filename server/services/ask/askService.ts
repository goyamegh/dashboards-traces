/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask service — answers a "highlight & ask" question with a streaming agent.
 *
 * Two backends behind one callback contract:
 *   - builtin: pi's agent loop IN-PROCESS (pi SDK, same pattern as the agent
 *     trace judge) with five read-only tools over this server's own API.
 *     Follow-ups reuse the same in-memory pi session.
 *   - connector: any configured agent whose connector can chat (claude-code /
 *     kiro / pi) via the existing `invokeAgent()` path — the question becomes
 *     a one-shot "test case" prompt; earlier turns are replayed as text.
 */

import { Type } from 'typebox';
import { loadConfigSync } from '@/lib/config/index';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';
import { resolveAgentModel } from '@/lib/resolveAgentModel';
import { invokeAgent } from '@/services/evaluation/index';
import { connectorRegistry } from '@/services/connectors/server';
import { getStorageModule } from '@/server/adapters/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import type { PiExtensionAPI, PiExtensionFactory, PiSdk, PiSession } from '@/server/services/piSdkTypes';
import { findRequestedModel, pickNewestClaudeModel } from '@/server/services/piAgenticJudgeService';
import type { TestCase, TrajectoryStep } from '@/types';
import { resolveAskAgent, type AskAgentChoice } from './askAgentResolver';
import {
  buildAskSnapshot,
  buildAskSystemPrompt,
  buildAskUserPrompt,
  resolveAskRefs,
  type AskPageContext,
  type AskRefs,
  type AskSelection,
} from './askContext';
import { getAskSessionStore, type AskSessionStore } from './askSessionStore';

// ============================================================================
// Public contract
// ============================================================================

export interface AskRequest {
  question: string;
  selections?: AskSelection[];
  pageContext: AskPageContext;
  agentKey?: string;
  /** Existing ask session to continue (follow-up). */
  sessionId?: string;
  /** UI variant, recorded on the session. */
  variant?: string;
  /** Pin the underlying LLM of the builtin assistant (provider-qualified or bare id). */
  modelId?: string;
}

export interface AskMeta {
  sessionId: string;
  turnId: string;
  agent: { key: string; name: string; connectorType: string };
  refs: AskRefs;
  /** Entities pre-loaded into the snapshot. */
  loaded: string[];
}

export interface AskCallbacks {
  onMeta(meta: AskMeta): void;
  onDelta(text: string): void;
  onTool(ev: { name: string; status: 'start' | 'end'; isError?: boolean; args?: unknown }): void;
  onDone(result: { answer: string; durationMs: number; firstTokenMs?: number; toolCalls: string[] }): void;
  onError(message: string): void;
}

export interface AskHandle {
  abort(): void;
}

// ============================================================================
// pi SDK (builtin)
// ============================================================================

async function loadPiSdk(): Promise<PiSdk> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as unknown as PiSdk;
  } catch (err: any) {
    throw new Error(
      'The built-in assistant requires the optional dependency "@earendil-works/pi-coding-agent" ' +
        `(${err?.message ?? String(err)}). Configure assistant.agentKey to use a CLI agent instead.`
    );
  }
}

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 1) }], details: obj };
}

/** Read-only tools over this server's own REST API. */
export function createAskToolsExtension(serverUrl: string, onCall?: (name: string) => void): PiExtensionFactory {
  const getJson = async (path: string) => {
    const res = await fetch(`${serverUrl}${path}`);
    if (!res.ok) return { error: `HTTP ${res.status} for ${path}` };
    return res.json();
  };
  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'get_report',
      label: 'Get a test-case report',
      description: 'Fetch one per-test-case report (trajectory, judge verdict + reasoning, metrics, traceId) by reportId.',
      parameters: Type.Object({ reportId: Type.String() }),
      async execute(_id: string, p: { reportId: string }) {
        onCall?.('get_report');
        const data: any = await getJson(`/api/storage/runs/${encodeURIComponent(p.reportId)}`);
        const r = data?.run ?? data;
        if (r?.trajectory && Array.isArray(r.trajectory)) {
          r.trajectory = r.trajectory.map((s: any, i: number) => ({
            i, type: s.type, toolName: s.toolName,
            content: typeof s.content === 'string' ? s.content.slice(0, 1200) : s.content,
            toolArgs: s.toolArgs, toolOutput: typeof s.toolOutput === 'string' ? s.toolOutput.slice(0, 1200) : s.toolOutput,
          }));
        }
        delete r?.rawEvents;
        return textResult(r);
      },
    });
    pi.registerTool({
      name: 'get_evaluation_run',
      label: 'Get an evaluation run',
      description: 'Fetch an evaluation run (benchmark execution): agent, stats, per-test-case results {testCaseId: {reportId, status}}.',
      parameters: Type.Object({ runId: Type.String() }),
      async execute(_id: string, p: { runId: string }) {
        onCall?.('get_evaluation_run');
        const data: any = await getJson(`/api/storage/evaluation-runs/${encodeURIComponent(p.runId)}`);
        const run = data?.evaluationRun ?? data;
        if (run?.testCaseSnapshots) {
          const names = Object.fromEntries(run.testCaseSnapshots.map((s: any) => [s.id, s.name]));
          run.results = Object.fromEntries(
            Object.entries(run.results ?? {}).map(([tc, r]: [string, any]) => [tc, { ...r, testCase: names[tc] }])
          );
          delete run.testCaseSnapshots;
        }
        return textResult(run);
      },
    });
    pi.registerTool({
      name: 'get_test_case',
      label: 'Get a test case',
      description: 'Fetch a test case definition (prompt, expected outcomes, labels).',
      parameters: Type.Object({ testCaseId: Type.String() }),
      async execute(_id: string, p: { testCaseId: string }) {
        onCall?.('get_test_case');
        const data: any = await getJson(`/api/storage/test-cases/${encodeURIComponent(p.testCaseId)}`);
        const tc = data?.testCase ?? data;
        delete tc?.sourceCode;
        return textResult(tc);
      },
    });
    pi.registerTool({
      name: 'get_benchmark',
      label: 'Get a benchmark',
      description: 'Fetch a benchmark (name, test case ids, run summaries with stats).',
      parameters: Type.Object({ benchmarkId: Type.String() }),
      async execute(_id: string, p: { benchmarkId: string }) {
        onCall?.('get_benchmark');
        const data: any = await getJson(`/api/storage/benchmarks/${encodeURIComponent(p.benchmarkId)}?fields=full`);
        const b = data?.benchmark ?? data;
        if (Array.isArray(b?.runs)) {
          b.runs = b.runs.slice(-30).map((r: any) => ({ id: r.id, name: r.name, createdAt: r.createdAt, status: r.status, agentKey: r.agentKey, stats: r.stats }));
        }
        return textResult(b);
      },
    });
    pi.registerTool({
      name: 'query_spans',
      label: 'Query OTel spans',
      description:
        'Fetch the OpenTelemetry spans of a run by traceId (preferred), runId (agent run id) and/or sessionId. ' +
        'Returns span names, timing, status and gen_ai.* attributes. Optional nameFilter substring.',
      parameters: Type.Object({
        traceId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        nameFilter: Type.Optional(Type.String()),
      }),
      async execute(_id: string, p: { traceId?: string; runId?: string; sessionId?: string; nameFilter?: string }) {
        onCall?.('query_spans');
        if (!p.traceId && !p.runId && !p.sessionId) return textResult({ error: 'Provide traceId, runId or sessionId.' });
        const body: Record<string, unknown> = { size: 300 };
        if (p.traceId) body.traceId = p.traceId;
        if (p.runId) body.runIds = [p.runId];
        if (p.sessionId) body.agents = [{ serviceName: 'unknown', sessionId: p.sessionId, startedAt: 0, endedAt: Date.now() }];
        const res = await fetch(`${serverUrl}/api/traces`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) return textResult({ error: `traces query failed: HTTP ${res.status}` });
        const data: any = await res.json();
        let spans: any[] = Array.isArray(data?.spans) ? data.spans : [];
        if (p.nameFilter) {
          const f = p.nameFilter.toLowerCase();
          spans = spans.filter((s) => String(s?.name ?? '').toLowerCase().includes(f));
        }
        return textResult({
          correlation: data?.correlation,
          spanCount: spans.length,
          spans: spans.map((s) => ({
            spanId: s.spanId, parentSpanId: s.parentSpanId, traceId: s.traceId, name: s.name,
            startTime: s.startTime, endTime: s.endTime, durationMs: s.durationMs ?? s.duration, status: s.status,
            attributes: s.attributes,
          })),
        });
      },
    });
  };
}

interface BuiltinSession {
  session: PiSession;
  unsubscribe?: () => void;
  modelId: string;
  lastUsed: number;
}
const builtinSessions = new Map<string, BuiltinSession>();
const BUILTIN_SESSION_TTL_MS = 30 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of builtinSessions) if (now - s.lastUsed > BUILTIN_SESSION_TTL_MS) builtinSessions.delete(id);
}, 5 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

function serverUrl(): string {
  return process.env.AH_JUDGE_SERVER_URL || `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
}

async function runBuiltin(
  askSessionId: string,
  systemPrompt: string,
  userPrompt: string,
  requestedModelId: string | undefined,
  cb: AskCallbacks,
  toolCalls: string[],
  firstToken: () => void,
  signal: { aborted: boolean }
): Promise<string> {
  const sdk = await loadPiSdk();
  let existing = builtinSessions.get(askSessionId);
  if (!existing) {
    const { createAgentSession, SessionManager, ModelRuntime, DefaultResourceLoader, getAgentDir } = sdk;
    const modelRuntime = await ModelRuntime.create();
    const available = (await modelRuntime.getAvailable()) as Array<{ provider: string; id: string }>;
    const pinned = requestedModelId ?? process.env.AH_ASK_MODEL_ID;
    const model = (pinned ? findRequestedModel(available, pinned.includes('/') ? pinned.slice(pinned.indexOf('/') + 1) : pinned) : undefined)
      ?? pickNewestClaudeModel(available);
    if (!model) throw new Error('Built-in assistant: no credentialed model in the pi registry (configure a Bedrock/Anthropic model for pi).');
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [createAskToolsExtension(serverUrl(), (n) => toolCalls.push(n))],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader,
      tools: ['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans'],
      sessionManager: SessionManager.inMemory(),
    });
    existing = { session, modelId: `${model.provider}/${model.id}`, lastUsed: Date.now() };
    builtinSessions.set(askSessionId, existing);
  }
  existing.lastUsed = Date.now();
  const session: any = existing.session;

  let answer = '';
  const unsubscribe: (() => void) | undefined = session.subscribe?.((event: any) => {
    if (signal.aborted) return;
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const d: string = event.assistantMessageEvent.delta ?? '';
      if (!d) return;
      // A tool-using turn produces several assistant messages; only the last
      // one is the answer, so reset the buffer when a new message starts.
      answer += d;
      firstToken();
      cb.onDelta(d);
    } else if (event.type === 'message_start' && event.message?.role === 'assistant') {
      if (answer) { cb.onDelta('\n\n'); answer += '\n\n'; }
    } else if (event.type === 'tool_execution_start') {
      cb.onTool({ name: event.toolName, status: 'start', args: event.args });
    } else if (event.type === 'tool_execution_end') {
      cb.onTool({ name: event.toolName, status: 'end', isError: !!event.isError });
    }
  });
  try {
    await session.prompt(userPrompt);
  } finally {
    unsubscribe?.();
  }
  if (signal.aborted) return answer;
  // The transcript is authoritative (the stream may have been interleaved with tool turns).
  const final = extractLastAssistantText(session.messages);
  return final || answer;
}

function extractLastAssistantText(messages: any[]): string {
  let last = '';
  for (const m of messages ?? []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('');
    if (text.trim()) last = text;
  }
  return last;
}

// ============================================================================
// Connector agents (claude-code / kiro / pi CLIs)
// ============================================================================

async function runConnector(
  choice: Extract<AskAgentChoice, { kind: 'connector' }>,
  systemPrompt: string,
  userPrompt: string,
  cb: AskCallbacks,
  toolCalls: string[],
  firstToken: () => void,
  signal: { aborted: boolean }
): Promise<string> {
  const { agent } = choice;
  const now = Date.now();
  // The chat turn is shaped as a one-shot test case so the existing connector
  // path (auth, hooks, env, model resolution) is reused unchanged.
  const testCase: TestCase = {
    id: `ask-${now}`,
    name: 'highlight-and-ask',
    description: 'Question asked from the Agent Health web UI',
    labels: [],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    initialPrompt: `${systemPrompt}\n\n${userPrompt}`,
    context: [],
    expectedOutcomes: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  } as unknown as TestCase;

  let streamed = '';
  let finalResponse = '';
  const onStep = (step: TrajectoryStep) => {
    if (signal.aborted) return;
    if (step.type === 'assistant' && step.content) {
      firstToken();
      const chunk = (streamed ? '\n\n' : '') + step.content;
      streamed += chunk;
      cb.onDelta(chunk);
    } else if (step.type === 'response' && step.content) {
      finalResponse = step.content;
      firstToken();
    } else if (step.type === 'action') {
      const name = step.toolName ?? 'tool';
      toolCalls.push(name);
      cb.onTool({ name, status: 'start', args: step.toolArgs });
    } else if (step.type === 'tool_result') {
      cb.onTool({ name: step.toolName ?? 'tool', status: 'end', isError: step.status === ('failure' as any) });
    }
  };

  const modelId = resolveAgentModel(agent);
  const result = await invokeAgent(agent, modelId, testCase, { registry: connectorRegistry, onStep });
  if (finalResponse.trim()) return finalResponse;
  if (streamed.trim()) return streamed;
  const texts = result.trajectory.filter((s) => s.type === 'assistant' || s.type === 'response').map((s) => s.content);
  return texts.join('\n\n');
}

// ============================================================================
// Entry point
// ============================================================================

export function streamAsk(req: AskRequest, cb: AskCallbacks, store: AskSessionStore = getAskSessionStore()): AskHandle {
  const signal = { aborted: false };
  const startedAt = Date.now();
  let firstTokenMs: number | undefined;
  const firstToken = () => { if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt; };
  const toolCalls: string[] = [];
  let turnRef: { sessionId: string; turnId: string } | null = null;

  (async () => {
    try {
      const choice = resolveAskAgentForRequest(req.agentKey);

      const selections = (req.selections ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
      const session = store.getOrCreate(req.sessionId, {
        agentKey: choice.key,
        agentName: choice.name,
        page: req.pageContext,
        selections,
        variant: req.variant,
      });
      const turn = store.startTurn(session.id, req.question, selections);
      turnRef = { sessionId: session.id, turnId: turn.id };

      const refs = resolveAskRefs(req.pageContext);
      const snapshot = await buildAskSnapshot(getStorageModule(), refs);
      cb.onMeta({
        sessionId: session.id,
        turnId: turn.id,
        agent: { key: choice.key, name: choice.name, connectorType: choice.connectorType },
        refs: snapshot.refs,
        loaded: snapshot.loaded,
      });
      if (signal.aborted) return;

      const toolMode = choice.kind === 'builtin' ? 'builtin-tools' : 'cli-tools';
      const systemPrompt = buildAskSystemPrompt({ serverUrl: serverUrl(), toolMode });
      const history = session.turns
        .filter((t) => t.id !== turn.id && t.answer)
        .map((t) => ({ question: t.question, answer: t.answer }));
      const userPrompt = buildAskUserPrompt({
        question: req.question,
        selections,
        page: req.pageContext,
        refs: snapshot.refs,
        snapshotMarkdown: snapshot.markdown,
        // The builtin pi session keeps its own history in memory; a fresh
        // session (server restart) gets the text replay like the CLIs do.
        history: choice.kind === 'builtin' && builtinSessions.has(session.id) ? [] : history,
        serverUrl: serverUrl(),
        toolMode,
      });
      debug('Ask', 'agent:', choice.key, 'refs:', JSON.stringify(snapshot.refs), 'prompt chars:', userPrompt.length);

      const answer = choice.kind === 'builtin'
        ? await runBuiltin(session.id, systemPrompt, userPrompt, req.modelId, cb, toolCalls, firstToken, signal)
        : await runConnector(choice, systemPrompt, userPrompt, cb, toolCalls, firstToken, signal);

      const durationMs = Date.now() - startedAt;
      store.finishTurn(session.id, turn.id, { answer, durationMs, firstTokenMs, toolCalls: [...toolCalls] });
      if (!signal.aborted) {
        if (!answer.trim()) {
          cb.onError('The agent returned no text.');
        } else {
          cb.onDone({ answer, durationMs, firstTokenMs, toolCalls: [...toolCalls] });
        }
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      debug('Ask', 'failed:', message);
      if (turnRef) store.finishTurn(turnRef.sessionId, turnRef.turnId, { error: message, durationMs: Date.now() - startedAt, toolCalls });
      if (!signal.aborted) cb.onError(message);
    }
  })();

  return {
    abort() {
      signal.aborted = true;
      if (turnRef) {
        const s = builtinSessions.get(turnRef.sessionId);
        s?.session.abort?.().catch(() => { /* ignore */ });
      }
    },
  };
}

/** Resolve the answering agent for a request (route uses it to 400 early on a bad key). */
export function resolveAskAgentForRequest(agentKey?: string): AskAgentChoice {
  const config = loadConfigSync();
  return resolveAskAgent({ agents: [...config.agents, ...safeCustomAgents()], assistant: config.assistant }, agentKey);
}

function safeCustomAgents() {
  try { return getCustomAgents(); } catch { return []; }
}

/** Test hook: drop in-memory pi sessions. @internal */
export function resetBuiltinAskSessions(): void {
  builtinSessions.clear();
}
