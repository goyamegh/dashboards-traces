/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge identity — "which judge KIND ran, and which LLM was actually behind it".
 *
 * Two fields, deliberately distinct:
 *
 *   - `judgeModelId` — the CONFIGURED judge (the run dialog / CLI
 *     `--judge-model` value). For plain providers this is a real model id
 *     (`us.anthropic.claude-sonnet-4-6`). For the agent (trace) judge it is
 *     `agent-trace-judge`, which names a PROVIDER whose underlying model is
 *     chosen at runtime from the pi registry — NOT a model.
 *   - `judgeModel`   — the UNDERLYING LLM the verdict actually came from, as
 *     the provider resolved it at judge time. Pre-fix this existed only on
 *     `llmJudgeResponse.judgeDebug.modelId`, which is `undefined` unless
 *     `AH_JUDGE_DEBUG=1`, so every agent-trace-judge report on the cluster
 *     said `agent-trace-judge` twice and never which LLM judged it.
 *
 * These helpers are the single place both persistence paths (the classic
 * runner, the benchmark runner, the trace-mode polled judge, retry-judgement,
 * browser recovery) and the UI derive the fields from, so a report can never
 * carry the provider name where a model id belongs — or vice versa.
 */

/** Judge-kind ids that name a provider rather than an LLM. */
const PROVIDER_PSEUDO_MODEL_IDS = new Set([
  'agent-trace-judge',
  'pi-judge',
  'agentic-claude-code',
  'agentic-custom',
  'claude-code-judge',
]);

/** True when `id` names a judge provider/kind (e.g. `agent-trace-judge`) rather than an LLM. */
export function isJudgeProviderPseudoModelId(id: string | undefined | null): boolean {
  return !!id && PROVIDER_PSEUDO_MODEL_IDS.has(id);
}

/** The subset of a judge result the identity fields are derived from. */
export interface JudgeIdentitySource {
  judgeModel?: string;
  judgeProvider?: string;
}

/**
 * The `judgeModel` to persist on a report: the provider's resolved LLM when
 * it reported one, else — for plain providers whose configured id IS the
 * model — the configured `judgeModelId` itself. For a provider pseudo-id
 * with no resolution (an old `/api/judge` build, or an agentic backend that
 * doesn't report its model) returns `undefined`: the field must not lie.
 */
export function resolveJudgeModelForReport(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): string | undefined {
  const resolved = judgment?.judgeModel?.trim();
  if (resolved) return resolved;
  if (judgeModelId && !isJudgeProviderPseudoModelId(judgeModelId)) return judgeModelId;
  return undefined;
}

/**
 * Report-level identity patch, spread into the persisted report alongside
 * `judgeModelId`: `{ judgeModel }` when known (never an explicit `undefined`
 * key, so partial-update merges don't clobber an earlier value).
 */
export function buildJudgeIdentityPatch(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): { judgeModel?: string; judgeProvider?: string } {
  const judgeModel = resolveJudgeModelForReport(judgment, judgeModelId);
  const judgeProvider = resolveJudgeProvider(judgment, judgeModelId);
  return {
    ...(judgeModel ? { judgeModel } : {}),
    ...(judgeProvider ? { judgeProvider } : {}),
  };
}

/**
 * The judge KIND for a report: what the judge service reported, else the
 * kind inferred from a provider pseudo-id (`agent-trace-judge` → `agent`).
 * Undefined for a plain model id with no provider reported (old server).
 */
export function resolveJudgeProvider(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): string | undefined {
  return judgment?.judgeProvider?.trim() || inferJudgeProviderFromId(judgeModelId);
}

/** Infer the judge kind from a provider pseudo-id; undefined for real model ids. */
export function inferJudgeProviderFromId(judgeModelId: string | undefined): string | undefined {
  if (judgeModelId === 'agent-trace-judge') return 'agent';
  if (judgeModelId === 'pi-judge') return 'pi';
  if (judgeModelId === 'claude-code-judge') return 'claude-code';
  if (judgeModelId?.startsWith('agentic-')) return 'agentic';
  return undefined;
}

/**
 * Marker persisted as `judgeProvider` on a report whose code-SDK body made
 * NO LLM judge call (code assertions / trace checks only). Lets the UI say
 * "No LLM judge" instead of presenting the run's configured judge as the
 * one that judged.
 */
export const JUDGE_PROVIDER_NONE = 'none';

/** The subset of a MatcherResult the SDK judge identity is derived from. */
export interface JudgeMatcherLike {
  method: string;
  errored?: boolean;
  notReached?: boolean;
  skipped?: boolean;
  model?: string;
  judgeModel?: string;
  judgeProvider?: string;
}

export interface SdkJudgeIdentity {
  /** Underlying LLM from the first llm-judge matcher that resolved one (never a pseudo-id). */
  judgeModel?: string;
  /** Judge kind of that matcher (or inferred from the requested id), or `'none'` when no LLM judge call was made. */
  judgeProvider?: string;
  /** Number of llm-judge matchers that actually reached the judge (skipped / not-reached rows excluded; errored calls count). */
  judgeCallCount: number;
}

/**
 * Report-level judge identity for a code-SDK test body, derived from its
 * recorded `matcherResults`. The SDK `judge()` fixture records one
 * `llm-judge` matcher per call carrying what `/api/judge` reported
 * (`judgeModel` / `judgeProvider`); this rolls the first resolved model up
 * so `report.judgeModel` is populated for SDK reports exactly like the
 * classic path does from `llmJudgeResponse`. Pre-fix nothing rolled up, so
 * every agent-trace-judge SDK report showed the provider with no model.
 *
 *   - `judgeModel`: first matcher's `judgeModel`; a pseudo-id is never
 *     accepted (an old server echoing the provider name). Falls back to the
 *     matcher's requested `model` / the run's `judgeModelId` only when that
 *     is a real model id (plain Bedrock judge on an old server).
 *   - `judgeProvider`: the matcher's reported kind, else inferred from the
 *     requested id; `'none'` when the body made no LLM judge call at all.
 */
export function resolveJudgeIdentityFromMatchers(
  matcherResults: readonly JudgeMatcherLike[] | undefined,
  judgeModelId: string | undefined
): SdkJudgeIdentity {
  const calls = (matcherResults ?? []).filter(
    m => m.method === 'llm-judge' && !m.notReached && !m.skipped
  );
  if (calls.length === 0) return { judgeProvider: JUDGE_PROVIDER_NONE, judgeCallCount: 0 };

  let judgeModel: string | undefined;
  let judgeProvider: string | undefined;
  for (const m of calls) {
    if (m.errored) continue;
    const requested = m.model || judgeModelId;
    const candidate = m.judgeModel?.trim();
    const resolved = candidate && !isJudgeProviderPseudoModelId(candidate)
      ? candidate
      : resolveJudgeModelForReport(undefined, requested);
    if (!judgeModel && resolved) judgeModel = resolved;
    if (!judgeProvider) judgeProvider = resolveJudgeProvider(m, requested);
    if (judgeModel && judgeProvider) break;
  }
  return {
    ...(judgeModel ? { judgeModel } : {}),
    ...(judgeProvider ? { judgeProvider } : {}),
    judgeCallCount: calls.length,
  };
}

/**
 * Report-level patch for a code-SDK test body — the SDK counterpart of
 * {@link buildJudgeIdentityPatch}: `{ judgeModel?, judgeProvider? }` from the
 * recorded matchers, `judgeProvider: 'none'` when the body made no LLM judge
 * call. Shared by the unified runner and the legacy benchmark runner so both
 * SDK persistence paths agree. Keys are omitted (never `undefined`) so a
 * partial-update merge can't clobber an earlier value.
 */
export function buildSdkJudgeIdentityPatch(
  matcherResults: readonly JudgeMatcherLike[] | undefined,
  judgeModelId: string | undefined
): { judgeModel?: string; judgeProvider?: string } {
  const { judgeModel, judgeProvider } = resolveJudgeIdentityFromMatchers(matcherResults, judgeModelId);
  return {
    ...(judgeModel ? { judgeModel } : {}),
    ...(judgeProvider ? { judgeProvider } : {}),
  };
}

/** The subset of a persisted report the consistency guard inspects. */
export interface JudgeIdentityReportLike {
  id?: string;
  judgeModelId?: string;
  judgeModel?: string;
  judgeProvider?: string;
  llmJudgeResponse?: { modelId?: string } | null;
  matcherResults?: readonly JudgeMatcherLike[];
  metricsStatus?: string;
}

/**
 * Runtime guard (not a source scan): did an LLM judge run on this report
 * without a resolved model being recorded? "An LLM judge ran" means the
 * classic `llmJudgeResponse` is present OR any `method: 'llm-judge'` matcher
 * actually reached the judge (skipped / not-reached rows don't count; a
 * report whose every judge call errored is exempt — there is no verdict
 * whose model could be recorded). Returns the problem as a string, or
 * `undefined` when the report is consistent. Pure; see
 * {@link assertJudgeIdentityConsistent} for the logging wrapper.
 */
export function findJudgeIdentityInconsistency(report: JudgeIdentityReportLike | undefined | null): string | undefined {
  if (!report) return undefined;
  const judgeCalls = (report.matcherResults ?? []).filter(
    m => m.method === 'llm-judge' && !m.notReached && !m.skipped
  );
  const completedCalls = judgeCalls.filter(m => !m.errored);
  const llmJudgeRan = !!report.llmJudgeResponse || completedCalls.length > 0;
  if (!llmJudgeRan) {
    if (judgeCalls.length === 0 && report.judgeModel && isJudgeProviderPseudoModelId(report.judgeModel)) {
      return `judgeModel "${report.judgeModel}" is a judge provider pseudo-id, not a model`;
    }
    return undefined;
  }
  if (!report.judgeModel) {
    return `an LLM judge ran (${report.llmJudgeResponse ? 'llmJudgeResponse' : `${completedCalls.length} llm-judge matcher(s)`}) but no resolved judgeModel was recorded` +
      (report.judgeModelId ? ` (judgeModelId: ${report.judgeModelId})` : '');
  }
  if (isJudgeProviderPseudoModelId(report.judgeModel)) {
    return `judgeModel "${report.judgeModel}" is a judge provider pseudo-id, not a model`;
  }
  if (report.judgeProvider === JUDGE_PROVIDER_NONE) {
    return `judgeProvider is '${JUDGE_PROVIDER_NONE}' although an LLM judge ran`;
  }
  return undefined;
}

/**
 * Runner-side consistency guard: logs `[JudgeIdentity] WARN <report id>: …`
 * (default `console.warn`) when {@link findJudgeIdentityInconsistency}
 * finds a problem. NEVER throws — a missing judge model must not fail a
 * run that already has its verdict; the warning is what makes the miss
 * visible in server logs / CI output instead of silently shipping a report
 * the UI can only render as "model not recorded". Returns `true` when the
 * report is consistent.
 */
export function assertJudgeIdentityConsistent(
  report: JudgeIdentityReportLike | undefined | null,
  log: (message: string) => void = (m) => console.warn(m)
): boolean {
  let problem: string | undefined;
  try {
    problem = findJudgeIdentityInconsistency(report);
  } catch {
    return true;
  }
  if (!problem) return true;
  try {
    log(`[JudgeIdentity] WARN ${report?.id ?? '(unsaved report)'}: ${problem}`);
  } catch { /* logging must never break the runner */ }
  return false;
}

/**
 * The `modelId` / `judgeProvider` pair for `LLMJudgeResponse`. `modelId`
 * is the REAL model when known (falls back to the configured id so the
 * field is never empty — old readers key on it), and `judgeProvider` keeps
 * the judge kind so nothing is lost by putting a real LLM id there.
 */
export function buildLlmJudgeResponseIdentity(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): { modelId: string; judgeProvider?: string } {
  const modelId = resolveJudgeModelForReport(judgment, judgeModelId) ?? judgeModelId ?? '';
  // Infer the kind from a provider pseudo-id when the service didn't say.
  const judgeProvider = resolveJudgeProvider(judgment, judgeModelId);
  return { modelId, ...(judgeProvider ? { judgeProvider } : {}) };
}

/**
 * Display helper: the judge model to SHOW for a report/run. Prefers the
 * recorded underlying LLM, falls back to the configured judge id (old
 * reports). Also says whether the fallback is a provider pseudo-id whose
 * real model was never recorded — the UI renders that as
 * "model not recorded — auto-picked at run time" rather than pretending
 * the provider name is a model.
 */
export function describeJudgeModel(run: { judgeModel?: string | null; judgeModelId?: string | null; judgeProvider?: string | null } | undefined | null): {
  /** Configured judge kind/id (`agent-trace-judge`, a Bedrock id, …) or undefined. */
  judgeModelId?: string;
  /** Underlying LLM when recorded. */
  judgeModel?: string;
  /** True when judgeModelId is a provider and the underlying model was never persisted. */
  modelNotRecorded: boolean;
  /** True when the report/run recorded that NO LLM judge call was made (code assertions only). */
  noLlmJudge: boolean;
} {
  const judgeModelId = run?.judgeModelId || undefined;
  const judgeModel = run?.judgeModel || undefined;
  const noLlmJudge = run?.judgeProvider === JUDGE_PROVIDER_NONE && !judgeModel;
  return {
    judgeModelId,
    judgeModel,
    modelNotRecorded: !noLlmJudge && !judgeModel && isJudgeProviderPseudoModelId(judgeModelId),
    noLlmJudge,
  };
}

/**
 * Short human label for a provider-qualified pi-registry id:
 * `amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0` →
 * `claude-sonnet-4-5`. Non-Claude / unrecognised ids are returned with only
 * the provider prefix stripped.
 */
export function shortJudgeModelLabel(judgeModel: string): string {
  const withoutProvider = judgeModel.includes('/') ? judgeModel.slice(judgeModel.indexOf('/') + 1) : judgeModel;
  const m = /claude-([a-z]+-\d+(?:-\d+)?)/i.exec(withoutProvider);
  if (m) return `claude-${m[1]}`;
  return withoutProvider;
}
