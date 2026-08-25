/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Deep-Dive (agentic).
 *
 * Generates the top-level "what's actually different" narrative for N runs
 * (2–4) being compared, by running pi's agent loop **in-process** (pi SDK,
 * `createAgentSession`) with read-only, run-scoped trace tools
 * (`query_spans` / `query_logs`) that can inspect ANY of the compared runs
 * (addressed as "A", "B", "C", "D").
 *
 * Unlike the agentic judge (single run, verdict JSON), this agent:
 *   - inspects EVERY compared run's real OTel spans/logs (Strategy B runId +
 *     Strategy C service.name + time-window, so closed-source agents like
 *     claude-code are visible even though they don't stamp gen_ai.request.id
 *     with our runId),
 *   - is seeded with a DETERMINISTIC, code-computed overview of the shared
 *     test-case matrix (agreement partition, per-category pass rates, split /
 *     all-fail case one-liners — see comparisonContextBuilder.ts) so it never
 *     has to count results itself and never sees the all-pass bulk,
 *   - can drill into a nominated "focus case" of any run via
 *     query_spans({ run, caseId }) instead of pre-fetching every case's traces,
 *   - writes a concise markdown deep-dive of the meaningful differences,
 *     INCLUDING any errors/failures observed in any of the runs,
 *   - cites specific spans as `[label](span:<runId>:<spanId>)` links the UI
 *     parses into deep-links into the trace view (same page).
 *
 * This is the engine behind `POST /api/comparison/deep-dive`.
 */

import { createComparisonTraceExtension } from './comparisonTraceTools';
import {
  findRequestedModel,
  pickJudgeModel,
  extractFinalAssistantText,
} from './piAgenticJudgeService';
import type { PiSdk } from './piSdkTypes';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';

/** Trace scope for one focus case of a run (drill-down target for tools). */
export interface ComparisonCaseScope {
  caseId: string;
  name?: string;
  /** The per-case agent-health run id (Strategy B). */
  runId?: string;
  /** Strategy C correlation hints for this case's execution window. */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
}

/** One run participating in the comparison. */
export interface ComparisonRunInput {
  /** Stable label the model addresses the run by in tool calls: 'A'–'D'. */
  key: string;
  /** Human-readable agent label, e.g. "aos-oncall (Claude Code)". */
  label: string;
  /** The agent-health run id (Strategy B). */
  runId?: string;
  /** Strategy C correlation hints (service.name + wall-clock window). */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
  /** Pass/fail + score for prompt context. */
  passFailStatus?: string;
  accuracy?: number;
  /** Top-level tool-call names from the trajectory (seed; details via tools). */
  toolNames?: string[];
  /** Wall-clock agent duration (ms) if known. */
  durationMs?: number;
  /** The agent's final answer text (seed context). */
  finalOutput?: string;
  /** Focus cases the agent may drill into via query_spans({ run, caseId }). */
  cases?: ComparisonCaseScope[];
}

export const MIN_COMPARED_RUNS = 2;
export const MAX_COMPARED_RUNS = 4;

export interface ComparisonDeepDiveResult {
  markdown: string;
  modelId: string;
  durationMs: number;
}

/** Dynamically load the pi SDK (optionalDependency) with an actionable error. */
async function loadPiSdk(): Promise<PiSdk> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as unknown as PiSdk;
  } catch (err: any) {
    throw new Error(
      'Comparison deep-dive requires the optional dependency "@earendil-works/pi-coding-agent". ' +
        `(${err?.message ?? String(err)})`
    );
  }
}

export const SYSTEM_PROMPT = `You are an expert evaluator comparing MULTIPLE runs (2–4) of (usually different) AI agents that were given the SAME tasks in the SAME harness. Each run has a stable key: "A", "B", "C", "D" (only the keys listed in the prompt exist). Your job is to explain — concisely and concretely — what is ACTUALLY different between how the agents behaved, grounded in their real execution traces.

The prompt may begin with a "Shared results overview" computed deterministically in code (agreement partition, per-run totals, per-category pass rates, split/all-fail case lists). TRUST those numbers — never recount them from spans — and use them to decide where to drill in: split cases (runs disagree) and all-fail cases carry the signal; all-pass cases rarely do.

You have read-only, run-scoped tools that return each run's REAL OpenTelemetry data:
  - query_spans({ run, caseId?, nameFilter? }) — a run's actual spans: tool calls + arguments, token usage, latency, gen_ai.* attributes. Each span has a spanId and runId. Pass caseId (an id from the focus-case lists, shown as [caseId]) to inspect that run's execution of THAT case; omit it for the representative case.
  - query_logs({ run, caseId?, query? }) — the run's correlated logs.

WORKFLOW:
1. Call query_spans for EVERY run key (start with no nameFilter to see the shape, then narrow). PREFER what the spans show over the trajectory summary in the prompt.
2. Drill into 1–3 of the listed focus cases where the overview shows disagreement — compare the runs' spans on the SAME case (e.g. run A vs run C on one split case) rather than trying to inspect every case.
3. Compare along the axes that actually differ for THESE runs — e.g. the model each agent actually ran (from gen_ai.request.model / gen_ai.response.model in the spans), correctness/outcome, thoroughness vs. speed, tool economy (how many/which tools, structured API vs. scraping), unique discoveries (a related ticket, a code path), investigation approach (direct vs. delegated to sub-agents), evidence volume, wasted/retry calls. Do NOT force a fixed rubric; surface what's interesting and real for these runs.
4. ERRORS — explicitly hunt for failures in EACH run: spans carrying an error/exception status or error attributes (e.g. otel.status_code=ERROR, status=ERROR, error=true, exception.message / exception.type, an HTTP/result status >= 400, a non-zero exit code), tool calls that failed or were retried repeatedly, timeouts, and error-/warn-level entries from query_logs. For every error you find, note WHICH run, WHAT failed, and HOW that agent handled it — recovered, retried, worked around it, or failed outright.
5. If a run has NO spans (traces unavailable), say so plainly and compare on the trajectory instead — never invent spans.

OUTPUT — ONE tight global markdown deep-dive covering all runs together (NOT per-pair sections, NOT a multi-question report). Structure:
  - A one-line **headline verdict** naming every run key (e.g. "C leads on accuracy; A was thorough, B was ~30% faster"; mention errors here if they materially changed the outcome).
  - 3–6 bullets of the concrete, material differences. Lead each bullet with the dimension in **bold**. A bullet may contrast a specific pair (e.g. A vs C on one split case) when that's where the signal is.
  - An **Errors** bullet that is ALWAYS present: call out every error/failure found in ANY run (run A, run B, or both/all) — what it was, which run it hit, and how that agent handled it (recovered / retried / ignored / failed) — each backed by a span or log citation. If a run had no errors, state "no errors observed" for that run explicitly; never silently omit it.
  - Be specific with numbers from the spans (tool counts, durations, tokens, error counts) when available.

SPAN CITATIONS (important): when a claim is backed by a specific span, cite it inline as a markdown link of EXACTLY this form:
    [short human label](span:<runId>:<spanId>)
using the exact runId and spanId from the query_spans output for that run (per-case drill-downs have their own runId — use the one from that tool output). The UI turns these into clickable links that open the span in the trace view on the same page. Cite 3–8 spans total — only where a span genuinely backs the claim. Do not fabricate spanIds; only cite spans you saw in tool output.

Keep it under ~280 words for 2 runs, up to ~400 words for 3–4 runs. No preamble, no "as an AI", no restating the task. Start with the headline.`;

export function buildUserPrompt(runs: ComparisonRunInput[], contextPrefix?: string): string {
  const keys = runs.map((r) => `"${r.key}"`).join(', ');
  const lines: string[] = [
    `Compare these ${runs.length} runs. Use query_spans / query_logs on EVERY run (${keys}) before writing.`,
    '',
  ];
  if (contextPrefix && contextPrefix.trim()) {
    lines.push(contextPrefix.trim(), '');
  }
  for (const r of runs) {
    lines.push(`## Run ${r.key} — ${r.label}`);
    if (r.runId) lines.push(`- runId (use this in span: citations): ${r.runId}`);
    if (r.passFailStatus) lines.push(`- outcome: ${r.passFailStatus}${typeof r.accuracy === 'number' ? ` (score ${r.accuracy})` : ''}`);
    if (typeof r.durationMs === 'number') lines.push(`- agent duration: ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.toolNames && r.toolNames.length) {
      lines.push(`- top-level tool calls (${r.toolNames.length}): ${r.toolNames.slice(0, 40).join(', ')}`);
    }
    if (r.finalOutput) {
      const snip = r.finalOutput.replace(/\s+/g, ' ').slice(0, 700);
      lines.push(`- final answer (excerpt): ${snip}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Run the comparison agent and return its markdown deep-dive.
 * Never throws past model/SDK setup — tool failures degrade to a
 * trajectory-only narrative.
 */
export async function generateComparisonDeepDive(opts: {
  runs: ComparisonRunInput[];
  modelId?: string;
  /** Deterministic prompt prefix from comparisonContextBuilder (optional). */
  contextPrefix?: string;
}): Promise<ComparisonDeepDiveResult> {
  const { runs } = opts;
  if (runs.length < MIN_COMPARED_RUNS || runs.length > MAX_COMPARED_RUNS) {
    throw new Error(
      `Comparison deep-dive expects ${MIN_COMPARED_RUNS}-${MAX_COMPARED_RUNS} runs, got ${runs.length}`
    );
  }
  const serverUrl =
    process.env.AH_JUDGE_SERVER_URL ||
    `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
  const startTime = Date.now();

  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir } =
    await loadPiSdk();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  const model = findRequestedModel(available, opts.modelId) ?? pickJudgeModel(available);
  if (!model) {
    throw new Error('Comparison deep-dive: no model available (configure a Bedrock/Anthropic model with valid credentials).');
  }
  debug('CompareDeepDive', 'model:', `${model.provider}/${model.id}`, 'runs:', runs.map((r) => r.key).join(','));

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [createComparisonTraceExtension(runs, serverUrl)],
    // Full isolation for a HEADLESS in-process session. Without noExtensions
    // the loader auto-loads the user's global ~/.pi/agent extensions (e.g.
    // midway-status) whose interactive theme/status `tick` timer throws
    // "Theme not initialized" and crashes the SERVER PROCESS. Our inline
    // extensionFactories (query_spans/query_logs) still register regardless.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    // Only the run-scoped trace tools — no filesystem/bash access.
    tools: ['query_spans', 'query_logs'],
    sessionManager: SessionManager.inMemory(),
  });

  await session.prompt(buildUserPrompt(runs, opts.contextPrefix));
  const markdown = extractFinalAssistantText(session.messages).trim();
  const durationMs = Date.now() - startTime;
  debug('CompareDeepDive', 'done in', durationMs, 'ms, markdown len', markdown.length);

  return { markdown, modelId: `${model.provider}/${model.id}`, durationMs };
}
