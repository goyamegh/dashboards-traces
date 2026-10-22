/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask service — THE Agent Health assistant: pi's agent loop in-process (pi SDK,
 * same pattern as the agent trace judge) with a fixed, code-enforced list of
 * READ-ONLY tools over this server's own API. No bash, no file access, no MCP,
 * no CLI spawn — `tools: ASK_TOOLS` is the whole tool surface.
 *
 * Threads are pi sessions (see askSessionStore.ts): a follow-up prompts the
 * same pi session, re-opened from its JSONL file if the server restarted.
 *
 * Time-to-first-token: the UI calls `prepareAsk()` as soon as the user starts
 * a question (chip click / composer focus). That builds the page snapshot and
 * creates the pi session while the user is still typing, so `streamAsk()` only
 * has to send the prompt.
 */

import { Type } from 'typebox';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';
import { getStorageModule } from '@/server/adapters/index';
import type { PiExtensionAPI, PiExtensionFactory, PiSdk, PiSession } from '@/server/services/piSdkTypes';
import { findRequestedModel, pickNewestClaudeModel } from '@/server/services/piAgenticJudgeService';
import {
  buildAskSnapshot,
  buildAskSystemPrompt,
  buildAskUserPrompt,
  resolveAskRefs,
  type AskPageContext,
  type AskRefs,
  type AskSelection,
} from './askContext';
import { PiAskSessionStore, defaultAskSessionsDir, type AskTurn, type PiSessionManagerLike } from './askSessionStore';

// ============================================================================
// The ONLY tools the assistant has. Pinned by a unit test.
// ============================================================================

export const ASK_TOOLS = ['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans'] as const;
export type AskToolName = (typeof ASK_TOOLS)[number];

export const ASK_AGENT = { key: 'agent-health-assistant', name: 'Agent Health assistant' } as const;

// ============================================================================
// Public contract
// ============================================================================

export interface AskRequest {
  question: string;
  selections?: AskSelection[];
  pageContext: AskPageContext;
  /** Existing ask session to continue (follow-up), or one returned by prepareAsk(). */
  sessionId?: string;
  /** Pin the underlying LLM (provider-qualified or bare id). Default: newest credentialed Claude. */
  modelId?: string;
}

export interface AskMeta {
  sessionId: string;
  turnId: string;
  agent: { key: string; name: string; model: string };
  refs: AskRefs;
  loaded: string[];
  /** True when the snapshot + pi session were prepared before the question arrived. */
  prepared: boolean;
}

export interface AskCallbacks {
  onMeta(meta: AskMeta): void;
  onDelta(text: string): void;
  onTool(ev: { name: string; status: 'start' | 'end'; isError?: boolean; args?: unknown }): void;
  onDone(result: { answer: string; durationMs: number; firstTokenMs?: number; toolCalls: string[] }): void;
  onError(message: string): void;
}

export interface AskHandle { abort(): void }

// ============================================================================
// pi SDK
// ============================================================================

async function loadPiSdk(): Promise<PiSdk & { SessionManager: any }> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as any;
  } catch (err: any) {
    throw new Error(
      'The Agent Health assistant requires the optional dependency "@earendil-works/pi-coding-agent" ' +
        `(${err?.message ?? String(err)}).`
    );
  }
}

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 1) }], details: obj };
}

/** Read-only tools over this server's own REST API (GETs + the POST /api/traces read). */
export function createAskToolsExtension(serverUrl: string): PiExtensionFactory {
  const getJson = async (path: string) => {
    const res = await fetch(`${serverUrl}${path}`);
    if (!res.ok) return { error: `HTTP ${res.status} for ${path}` };
    return res.json();
  };
  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'get_report',
      label: 'Get a test-case report',
      description: 'Fetch one per-test-case report (full trajectory, judge verdict + reasoning, metrics, traceId) by reportId. Only for reports NOT already in the snapshot.',
      parameters: Type.Object({ reportId: Type.String() }),
      async execute(_id: string, p: { reportId: string }) {
        const data: any = await getJson(`/api/storage/runs/${encodeURIComponent(p.reportId)}`);
        const r = data?.run ?? data;
        if (Array.isArray(r?.trajectory)) {
          r.trajectory = r.trajectory.map((s: any, i: number) => ({
            i, type: s.type, toolName: s.toolName,
            content: typeof s.content === 'string' ? s.content.slice(0, 1500) : s.content,
            toolArgs: s.toolArgs, toolOutput: typeof s.toolOutput === 'string' ? s.toolOutput.slice(0, 1500) : s.toolOutput,
          }));
        }
        if (r) delete r.rawEvents;
        return textResult(r);
      },
    });
    pi.registerTool({
      name: 'get_evaluation_run',
      label: 'Get an evaluation run',
      description: 'Fetch an evaluation run (benchmark execution): agent, stats, per-test-case results {testCaseId: {reportId, status, testCase}}.',
      parameters: Type.Object({ runId: Type.String() }),
      async execute(_id: string, p: { runId: string }) {
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
        const data: any = await getJson(`/api/storage/test-cases/${encodeURIComponent(p.testCaseId)}`);
        const tc = data?.testCase ?? data;
        if (tc) delete tc.sourceCode;
        return textResult(tc);
      },
    });
    pi.registerTool({
      name: 'get_benchmark',
      label: 'Get a benchmark',
      description: 'Fetch a benchmark (name, test case ids, run summaries with stats).',
      parameters: Type.Object({ benchmarkId: Type.String() }),
      async execute(_id: string, p: { benchmarkId: string }) {
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

function serverUrl(): string {
  return process.env.AH_JUDGE_SERVER_URL || `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
}

// ----------------------------------------------------------------------------
// Process-wide runtime cache (model registry + credentials). Cheap (~50 ms) but
// re-read every few minutes so rotated credentials / a new pin are picked up.
// ----------------------------------------------------------------------------

interface Runtime { sdk: Awaited<ReturnType<typeof loadPiSdk>>; modelRuntime: any; model: { provider: string; id: string }; at: number; pin?: string }
let runtimeCache: Runtime | null = null;
const RUNTIME_TTL_MS = 5 * 60 * 1000;

async function getRuntime(requestedModelId?: string): Promise<Runtime> {
  const pin = requestedModelId ?? process.env.AH_ASK_MODEL_ID;
  if (runtimeCache && runtimeCache.pin === pin && Date.now() - runtimeCache.at < RUNTIME_TTL_MS) return runtimeCache;
  const sdk = await loadPiSdk();
  const modelRuntime = await sdk.ModelRuntime.create();
  const available = (await modelRuntime.getAvailable()) as Array<{ provider: string; id: string }>;
  const model = (pin ? findRequestedModel(available, pin.includes('/') ? pin.slice(pin.indexOf('/') + 1) : pin) : undefined)
    ?? pickNewestClaudeModel(available);
  if (!model) throw new Error('Agent Health assistant: no credentialed model in the pi registry (configure a Bedrock/Anthropic model for pi).');
  runtimeCache = { sdk, modelRuntime, model, at: Date.now(), pin };
  return runtimeCache;
}

// ----------------------------------------------------------------------------
// Live sessions
// ----------------------------------------------------------------------------

interface LiveSession {
  id: string;
  session: PiSession & { subscribe?: (l: (e: any) => void) => () => void };
  sm: PiSessionManagerLike;
  model: string;
  page: AskPageContext;
  /** Snapshot built for the first turn (consumed by the first prompt). */
  snapshot?: { markdown: string; refs: AskRefs; loaded: string[] };
  /** Whether any turn has been prompted in this process. */
  turns: number;
  lastUsed: number;
  busy: boolean;
}
const live = new Map<string, LiveSession>();
const LIVE_TTL_MS = 30 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of live) if (!s.busy && now - s.lastUsed > LIVE_TTL_MS) live.delete(id);
}, 5 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

let storeSingleton: PiAskSessionStore | null = null;
async function getStore(): Promise<PiAskSessionStore> {
  if (!storeSingleton) {
    const sdk = await loadPiSdk();
    storeSingleton = new PiAskSessionStore(sdk.SessionManager, defaultAskSessionsDir());
  }
  return storeSingleton;
}
export async function getAskSessionStore(): Promise<PiAskSessionStore> { return getStore(); }

async function createPiSession(rt: Runtime, sm: PiSessionManagerLike): Promise<LiveSession['session']> {
  const { createAgentSession, DefaultResourceLoader, getAgentDir } = rt.sdk;
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => buildAskSystemPrompt(),
    appendSystemPromptOverride: () => [],
    extensionFactories: [createAskToolsExtension(serverUrl())],
    // Headless + isolated: no user extensions/skills/themes/context files.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    model: rt.model,
    modelRuntime: rt.modelRuntime,
    resourceLoader,
    // READ-ONLY by construction: exactly these tools, nothing built-in.
    tools: [...ASK_TOOLS],
    sessionManager: sm,
  });
  return session as LiveSession['session'];
}

/**
 * Build the page snapshot and create the pi session BEFORE the question
 * arrives. Returns the session id the client must send with `streamAsk`.
 */
export async function prepareAsk(input: { pageContext: AskPageContext; selections?: AskSelection[]; modelId?: string }): Promise<{ sessionId: string; refs: AskRefs; loaded: string[]; model: string }> {
  const t0 = Date.now();
  const [rt, store, snapshot] = await Promise.all([
    getRuntime(input.modelId),
    getStore(),
    buildAskSnapshot(getStorageModule(), resolveAskRefs(input.pageContext)),
  ]);
  const selections = (input.selections ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
  const sm = store.create({ page: input.pageContext, selections, firstQuestion: '' });
  const session = await createPiSession(rt, sm);
  const id = sm.getSessionId();
  live.set(id, { id, session, sm, model: `${rt.model.provider}/${rt.model.id}`, page: input.pageContext, snapshot, turns: 0, lastUsed: Date.now(), busy: false });
  debug('Ask', 'prepared', id, 'in', Date.now() - t0, 'ms; loaded:', snapshot.loaded.join(', '));
  return { sessionId: id, refs: snapshot.refs, loaded: snapshot.loaded, model: `${rt.model.provider}/${rt.model.id}` };
}

/** Get a live session: prepared in memory, or re-opened from its pi JSONL file (restart), or null. */
async function resumeSession(id: string, rt: Runtime): Promise<LiveSession | null> {
  const found = live.get(id);
  if (found) return found;
  const store = await getStore();
  const sm = store.open(id);
  if (!sm) return null;
  const detail = store.get(id);
  const session = await createPiSession(rt, sm);
  const ls: LiveSession = { id, session, sm, model: `${rt.model.provider}/${rt.model.id}`, page: detail?.page ?? { route: '/' }, turns: detail?.turns.length ?? 1, lastUsed: Date.now(), busy: false };
  live.set(id, ls);
  debug('Ask', 'resumed pi session from file', sm.getSessionFile());
  return ls;
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
// Entry point
// ============================================================================

export function streamAsk(req: AskRequest, cb: AskCallbacks): AskHandle {
  const signal = { aborted: false };
  const startedAt = Date.now();
  let firstTokenMs: number | undefined;
  const firstToken = () => { if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt; };
  const toolCalls: string[] = [];
  let ls: LiveSession | null = null;

  (async () => {
    try {
      const rt = await getRuntime(req.modelId);
      const selections = (req.selections ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
      let prepared = false;
      if (req.sessionId) {
        ls = await resumeSession(req.sessionId, rt);
        if (!ls) throw new Error(`Ask session ${req.sessionId} not found`);
        prepared = !!ls.snapshot;
      }
      if (!ls) {
        const p = await prepareAsk({ pageContext: req.pageContext, selections, modelId: req.modelId });
        ls = live.get(p.sessionId)!;
      }
      if (ls.busy) throw new Error('This ask session is still answering a previous question.');
      ls.busy = true;
      ls.lastUsed = Date.now();
      if (ls.turns === 0) ls.sm.appendSessionInfo(req.question.slice(0, 120));

      // First turn: the prepared snapshot. Follow-ups: pi already has the
      // snapshot in context; only send a fresh one if the page changed.
      const sameRoute = ls.page.route === req.pageContext.route;
      let snapshot = ls.snapshot;
      if (!snapshot && (ls.turns === 0 || !sameRoute)) {
        snapshot = await buildAskSnapshot(getStorageModule(), resolveAskRefs(req.pageContext));
      }
      ls.snapshot = undefined;
      const refs = snapshot?.refs ?? resolveAskRefs(req.pageContext);
      const turnId = `turn-${Date.now().toString(36)}`;
      cb.onMeta({
        sessionId: ls.id, turnId,
        agent: { ...ASK_AGENT, model: ls.model },
        refs, loaded: snapshot?.loaded ?? [], prepared,
      });
      if (signal.aborted) { ls.busy = false; return; }

      const userPrompt = buildAskUserPrompt({
        question: req.question,
        selections,
        page: req.pageContext,
        refs,
        snapshotMarkdown: snapshot?.markdown ?? '',
        isFollowUp: ls.turns > 0,
      });
      debug('Ask', 'session', ls.id, 'turn', ls.turns + 1, 'prompt chars', userPrompt.length, 'prepared', prepared);

      let streamed = '';
      const unsubscribe = ls.session.subscribe?.((event: any) => {
        if (signal.aborted) return;
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          const d: string = event.assistantMessageEvent.delta ?? '';
          if (!d) return;
          streamed += d; firstToken(); cb.onDelta(d);
        } else if (event.type === 'message_start' && event.message?.role === 'assistant' && streamed) {
          streamed += '\n\n'; cb.onDelta('\n\n');
        } else if (event.type === 'tool_execution_start') {
          toolCalls.push(event.toolName);
          cb.onTool({ name: event.toolName, status: 'start', args: event.args });
        } else if (event.type === 'tool_execution_end') {
          cb.onTool({ name: event.toolName, status: 'end', isError: !!event.isError });
        }
      });
      const turnStartedAt = new Date().toISOString();
      try {
        await ls.session.prompt(userPrompt);
      } finally {
        unsubscribe?.();
        ls.turns += 1;
        ls.busy = false;
        ls.lastUsed = Date.now();
      }
      const answer = extractLastAssistantText(ls.session.messages) || streamed;
      const durationMs = Date.now() - startedAt;
      const turn: AskTurn = {
        id: turnId, question: req.question, answer, selections, startedAt: turnStartedAt,
        completedAt: new Date().toISOString(), durationMs, firstTokenMs, toolCalls: [...toolCalls],
        error: answer.trim() ? undefined : 'The assistant returned no text.',
      };
      (await getStore()).recordTurn(ls.sm, turn);
      if (signal.aborted) return;
      if (!answer.trim()) cb.onError('The assistant returned no text.');
      else cb.onDone({ answer, durationMs, firstTokenMs, toolCalls: [...toolCalls] });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      debug('Ask', 'failed:', message);
      if (ls) ls.busy = false;
      if (!signal.aborted) cb.onError(message);
    }
  })();

  return {
    abort() {
      signal.aborted = true;
      ls?.session.abort?.().catch(() => { /* ignore */ });
    },
  };
}

/** Test hook: drop in-memory sessions and the runtime cache. @internal */
export function resetAskServiceState(): void {
  live.clear();
  runtimeCache = null;
  storeSingleton = null;
}
