/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Case TL;DR service — a 3-sentence plain-language summary of one test case
 * run, shown above the "Test Case Definition" in the run inspector:
 *
 *   1. ASKED   — what the test asked the agent to do (prompt + expectation)
 *   2. AGENT   — what the agent actually did / answered
 *   3. VERDICT — the judgement and its main reason (or why it wasn't judged)
 *
 * The summary is written by an LLM (same Bedrock Converse path as the judge,
 * through the refreshing credential provider — #569), generated lazily on
 * first view and cached on the report as `report.caseSummary`. The cache key
 * is a hash of the exact inputs the prompt was built from (prompt, expected
 * outcomes, final answer, tools, verdict, reasoning, error), so whenever the
 * judgement changes — e.g. after "Retry judgement" — the stored summary no
 * longer matches and is regenerated on the next view. No hook into the
 * retry path is needed.
 *
 * Honesty rules (owner: "errors ⇒ no metrics, never zeros"):
 *   - agent / judge errors are summarised as "not judged — <cause>", never
 *     as a verdict;
 *   - when the LLM is unavailable or errors, a deterministic FIELD-BASED
 *     summary (built from the same inputs) is returned with
 *     `source: 'fallback'` and the error text, and is NOT persisted, so the
 *     next view tries the LLM again. The UI labels it as such.
 *
 * Everything in the prompt is agent- and benchmark-agnostic; the inputs are
 * truncated so one summary costs a bounded number of tokens.
 */

import { createHash } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import config from '../config';
import { debug } from '@/lib/debug';
import { buildInferenceConfig, resolveRegionAwareModelId } from '@/lib/bedrockCompat';
import { createRefreshingCredentialProvider } from '@/lib/aws/refreshingCredentialProvider';
import { getJudgeReasoningText } from '@/lib/matchers/judgeAccessor';
import { getFailureStage, getFailureCause } from '@/lib/reportFailure';
import type { CaseSummary, CaseSummaryParts, TestCase, TestCaseRun } from '@/types';

// ─── Input bounding ──────────────────────────────────────────────────────────

export const CASE_SUMMARY_LIMITS = {
  prompt: 1500,
  expected: 800,
  answer: 1500,
  reasoning: 1500,
  tools: 12,
} as const;

/** Default wall-clock budget for one LLM summary call. */
export const CASE_SUMMARY_TIMEOUT_MS = Number(process.env.CASE_SUMMARY_TIMEOUT_MS) || 20_000;

/**
 * Model used for summaries. Falls back to the judge's default Bedrock model so
 * a working judge setup needs no extra configuration.
 */
export function getCaseSummaryModelId(): string {
  return process.env.CASE_SUMMARY_MODEL_ID || config.BEDROCK_MODEL_ID;
}

export function truncateForSummary(text: string | undefined | null, max: number): string {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The bounded, judgement-bearing facts one summary is written from. */
export interface CaseSummaryInputs {
  testCaseName: string;
  prompt: string;
  expectedOutcomes: string[];
  agentName: string;
  toolsUsed: string[];
  stepCount: number;
  finalAnswer: string;
  /** 'passed' | 'failed' | 'not_judged' */
  verdict: 'passed' | 'failed' | 'not_judged';
  /** Set when verdict is 'not_judged': which stage failed and the cause. */
  notJudged?: { stage: 'agent' | 'judge' | 'trace' | 'pending' | 'unknown'; cause: string };
  score?: number;
  reasoning: string;
  judgeModel?: string;
}

function extractFinalAnswer(report: TestCaseRun): string {
  const traj = Array.isArray(report.trajectory) ? report.trajectory : [];
  for (let i = traj.length - 1; i >= 0; i--) {
    const s: any = traj[i];
    if (!s || s.type === 'tool_result' || s.type === 'action') continue;
    const text = s.content ?? s.text ?? s.output;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return '';
}

function extractToolsUsed(report: TestCaseRun): string[] {
  const traj = Array.isArray(report.trajectory) ? report.trajectory : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of traj as any[]) {
    const name = s?.toolName;
    if (typeof name === 'string' && name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function currentPrompt(testCase: TestCase | null | undefined): string {
  if (!testCase) return '';
  if (testCase.initialPrompt) return testCase.initialPrompt;
  const v = testCase.versions?.find(x => x.version === testCase.currentVersion) || testCase.versions?.[testCase.versions.length - 1];
  return (v as any)?.content?.initialPrompt || (v as any)?.initialPrompt || '';
}

function currentExpected(testCase: TestCase | null | undefined): string[] {
  if (!testCase) return [];
  if (Array.isArray(testCase.expectedOutcomes) && testCase.expectedOutcomes.length) return testCase.expectedOutcomes;
  const v = testCase.versions?.find(x => x.version === testCase.currentVersion) || testCase.versions?.[testCase.versions.length - 1];
  const exp = (v as any)?.content?.expectedOutcomes || (v as any)?.expectedOutcomes;
  return Array.isArray(exp) ? exp : [];
}

/**
 * Build the bounded inputs. Pure; the hash of this object is the cache key.
 */
export function buildCaseSummaryInputs(report: TestCaseRun, testCase: TestCase | null | undefined): CaseSummaryInputs {
  const stage = getFailureStage(report);
  const errored = report.metricsStatus === 'error' || stage === 'agent' || stage === 'judge' || stage === 'trace';
  const pending = !errored && (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating' || report.status === 'running');
  const hasVerdict = !errored && !pending && (report.passFailStatus === 'passed' || report.passFailStatus === 'failed');

  let verdict: CaseSummaryInputs['verdict'] = 'not_judged';
  let notJudged: CaseSummaryInputs['notJudged'];
  if (hasVerdict) {
    verdict = report.passFailStatus as 'passed' | 'failed';
  } else if (pending) {
    notJudged = { stage: 'pending', cause: report.metricsStatus === 'calculating' ? 'judgement in progress' : 'run still in progress' };
  } else {
    const cause = getFailureCause(report) || (report.status === 'failed' ? 'the run failed before a verdict was produced' : 'no verdict was recorded');
    notJudged = { stage: stage ?? 'unknown', cause: truncateForSummary(cause, 300) };
  }

  const expected = currentExpected(testCase).map(e => truncateForSummary(e, 200));
  // Keep the joined expectation list bounded too.
  const boundedExpected: string[] = [];
  let used = 0;
  for (const e of expected) {
    if (used + e.length > CASE_SUMMARY_LIMITS.expected) break;
    boundedExpected.push(e);
    used += e.length;
  }

  return {
    testCaseName: testCase?.name || report.testCaseId,
    prompt: truncateForSummary(currentPrompt(testCase), CASE_SUMMARY_LIMITS.prompt),
    expectedOutcomes: boundedExpected,
    agentName: report.agentName || report.agentKey || 'the agent',
    toolsUsed: extractToolsUsed(report).slice(0, CASE_SUMMARY_LIMITS.tools),
    stepCount: Array.isArray(report.trajectory) ? report.trajectory.length : 0,
    finalAnswer: truncateForSummary(extractFinalAnswer(report), CASE_SUMMARY_LIMITS.answer),
    verdict,
    notJudged,
    score: typeof report.score === 'number' ? report.score : undefined,
    reasoning: verdict === 'not_judged' ? '' : truncateForSummary(getJudgeReasoningText(report), CASE_SUMMARY_LIMITS.reasoning),
    judgeModel: report.judgeModel || report.judgeModelId,
  };
}

/** Stable short hash of the inputs — the cache key stored as `caseSummary.inputsHash`. */
export function hashCaseSummaryInputs(inputs: CaseSummaryInputs): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16);
}

/** True when `cached` was generated from exactly these inputs. */
export function isCaseSummaryCurrent(cached: CaseSummary | undefined | null, inputs: CaseSummaryInputs): boolean {
  return !!cached && cached.source === 'llm' && cached.inputsHash === hashCaseSummaryInputs(inputs);
}

// ─── Deterministic fallback ─────────────────────────────────────────────────

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function firstSentence(text: string, max = 220): string {
  const t = text.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return truncateForSummary(s, max);
}

export function describeNotJudged(nj: NonNullable<CaseSummaryInputs['notJudged']>): string {
  const cause = nj.cause ? ` — ${nj.cause.replace(/\.$/, '')}` : '';
  switch (nj.stage) {
    case 'agent': return `Not judged: the agent request failed${cause}`;
    case 'judge': return `Not judged: the judge could not produce a verdict${cause}`;
    case 'trace': return `Not judged: traces for the run could not be collected${cause}`;
    case 'pending': return `Not judged yet: ${nj.cause}`;
    default: return `Not judged${cause}`;
  }
}

/**
 * Field-based summary used when the LLM is unavailable. Same three parts as
 * the LLM version so the UI renders both identically.
 */
export function buildFallbackSummaryParts(inputs: CaseSummaryInputs): CaseSummaryParts {
  const askedCore = inputs.prompt ? `The test asks: “${truncateForSummary(inputs.prompt, 240)}”` : `The test “${inputs.testCaseName}” has no recorded prompt`;
  const expect = inputs.expectedOutcomes.length === 1
    ? ` Expected outcome: “${truncateForSummary(inputs.expectedOutcomes[0], 160).replace(/\.$/, '')}”.`
    : inputs.expectedOutcomes.length > 1
      ? ` It has ${inputs.expectedOutcomes.length} expected outcomes, e.g. “${truncateForSummary(inputs.expectedOutcomes[0], 120).replace(/\.$/, '')}”.`
      : '';
  const asked = sentence(askedCore) + expect;

  let agent: string;
  if (inputs.notJudged?.stage === 'agent' && !inputs.finalAnswer) {
    agent = sentence(`${inputs.agentName} produced no output`);
  } else {
    const tools = inputs.toolsUsed.length ? ` used ${inputs.toolsUsed.length === 1 ? 'the tool' : 'tools'} ${inputs.toolsUsed.slice(0, 4).join(', ')}${inputs.toolsUsed.length > 4 ? ` (+${inputs.toolsUsed.length - 4} more)` : ''} and` : '';
    const answer = inputs.finalAnswer ? ` answered: “${truncateForSummary(inputs.finalAnswer, 260)}”` : ` finished ${inputs.stepCount} step${inputs.stepCount === 1 ? '' : 's'} without a final text answer`;
    agent = sentence(`${inputs.agentName}${tools}${answer}`);
  }

  let verdict: string;
  if (inputs.verdict === 'not_judged' && inputs.notJudged) {
    verdict = sentence(describeNotJudged(inputs.notJudged));
  } else {
    const label = inputs.verdict === 'passed' ? 'PASSED' : 'FAILED';
    const score = typeof inputs.score === 'number' ? ` (score ${Math.round(inputs.score * 100)}%)` : '';
    const why = firstSentence(inputs.reasoning);
    verdict = sentence(`Judge verdict: ${label}${score}${why ? ` — ${why.replace(/\.$/, '')}` : ''}`);
  }

  return { asked, agent, verdict };
}

export function partsToText(parts: CaseSummaryParts): string {
  return [parts.asked, parts.agent, parts.verdict].map(s => s.trim()).filter(Boolean).join(' ');
}

export function buildFallbackSummary(inputs: CaseSummaryInputs, error?: string): CaseSummary {
  const parts = buildFallbackSummaryParts(inputs);
  return {
    source: 'fallback',
    parts,
    text: partsToText(parts),
    generatedAt: new Date().toISOString(),
    inputsHash: hashCaseSummaryInputs(inputs),
    ...(error ? { error } : {}),
  };
}

// ─── LLM path ───────────────────────────────────────────────────────────────

export const CASE_SUMMARY_SYSTEM_PROMPT =
  'You write short, factual TL;DR summaries of AI-agent evaluation results for engineers. ' +
  'You never invent facts: use only the provided fields. Plain language, no marketing tone, no markdown. ' +
  'Respond with strictly valid JSON and nothing else.';

export function buildCaseSummaryPrompt(inputs: CaseSummaryInputs): string {
  const lines: string[] = [];
  lines.push('Summarise this single test-case run in exactly three sentences, returned as JSON with keys "asked", "agent", "verdict":');
  lines.push('- "asked": what the test asked the agent to do and what a good answer needed to contain (one sentence).');
  lines.push('- "agent": what the agent actually did and answered — mention tools used if any (one sentence).');
  if (inputs.verdict === 'not_judged') {
    lines.push('- "verdict": this run was NOT judged. State that plainly and give the reason from the fields; do not guess a pass/fail (one sentence).');
  } else {
    lines.push(`- "verdict": the judge's verdict (${inputs.verdict.toUpperCase()}) and its main reason, taken from the judge reasoning (one sentence).`);
  }
  lines.push('Each sentence ≤ 45 words. Quote the agent\'s answer briefly only when it helps.');
  lines.push('');
  lines.push('FIELDS');
  lines.push(`test_case_name: ${inputs.testCaseName}`);
  lines.push(`prompt: ${inputs.prompt || '(none recorded)'}`);
  lines.push(`expected_outcomes: ${inputs.expectedOutcomes.length ? inputs.expectedOutcomes.map((e, i) => `(${i + 1}) ${e}`).join(' ') : '(none recorded)'}`);
  lines.push(`agent: ${inputs.agentName}`);
  lines.push(`tools_used: ${inputs.toolsUsed.length ? inputs.toolsUsed.join(', ') : '(none)'}`);
  lines.push(`trajectory_steps: ${inputs.stepCount}`);
  lines.push(`final_answer: ${inputs.finalAnswer || '(no final text answer)'}`);
  lines.push(`verdict: ${inputs.verdict}`);
  if (inputs.notJudged) lines.push(`not_judged_reason: stage=${inputs.notJudged.stage}; ${inputs.notJudged.cause}`);
  if (typeof inputs.score === 'number') lines.push(`score: ${Math.round(inputs.score * 100)}%`);
  if (inputs.reasoning) lines.push(`judge_reasoning: ${inputs.reasoning}`);
  if (inputs.judgeModel) lines.push(`judge_model: ${inputs.judgeModel}`);
  lines.push('');
  lines.push('Return only: {"asked": "...", "agent": "...", "verdict": "..."}');
  return lines.join('\n');
}

/** Parse the model's JSON (tolerating fences, surrounding prose, trailing commas). */
export function parseCaseSummaryResponse(text: string): CaseSummaryParts {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('summary model returned no JSON object');
  const raw = text.slice(start, end + 1);
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    try {
      obj = JSON.parse(raw.replace(/,\s*}/g, '}'));
    } catch {
      // Last resort: pull each key's string value out directly — models
      // occasionally leave an unescaped quote or stray text inside the object.
      obj = {};
      for (const k of ['asked', 'agent', 'verdict']) {
        // Lazy up to the quote that is followed by the next key or the
        // closing brace, so an unescaped quote inside a value doesn't cut it.
        const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"(?:asked|agent|verdict)"\\s*:|,?\\s*})`));
        if (m) obj[k] = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
      }
    }
  }
  const pick = (k: string) => (typeof obj?.[k] === 'string' ? obj[k].trim() : '');
  const parts = { asked: pick('asked'), agent: pick('agent'), verdict: pick('verdict') };
  if (!parts.asked || !parts.agent || !parts.verdict) throw new Error('summary model JSON is missing asked/agent/verdict');
  return parts;
}

// Lazily-constructed, long-lived client. Lazy so the endpoint/region env is
// read when the server actually first needs it (tests point
// AWS_ENDPOINT_URL_BEDROCK_RUNTIME at a local verifying server), long-lived
// so credential refresh (#569) happens inside one provider instance.
let bedrockClient: BedrockRuntimeClient | undefined;
function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region: config.AWS_REGION,
      credentials: createRefreshingCredentialProvider(),
    });
  }
  return bedrockClient;
}

/** Test helper: drop the cached client so a new endpoint/region is picked up. */
export function _resetCaseSummaryClient(): void {
  bedrockClient = undefined;
}

export interface GenerateCaseSummaryOptions {
  /** Ignore a current cached summary and ask the LLM again. */
  force?: boolean;
  /** Wall-clock budget for the LLM call. */
  timeoutMs?: number;
  /** Persist the fresh LLM summary onto the report (the route passes storage.runs.update). */
  persist?: (summary: CaseSummary) => Promise<unknown>;
}

export interface GenerateCaseSummaryResult {
  summary: CaseSummary;
  /** True when the stored summary was returned without an LLM call. */
  cached: boolean;
}

/**
 * Return the current summary for a report: the cached one when its
 * `inputsHash` still matches, otherwise a fresh LLM summary (persisted via
 * `persist`), otherwise the field-based fallback with the LLM error attached.
 */
export async function generateCaseSummary(
  report: TestCaseRun,
  testCase: TestCase | null | undefined,
  options: GenerateCaseSummaryOptions = {}
): Promise<GenerateCaseSummaryResult> {
  const inputs = buildCaseSummaryInputs(report, testCase);
  const inputsHash = hashCaseSummaryInputs(inputs);

  if (!options.force && isCaseSummaryCurrent(report.caseSummary, inputs)) {
    return { summary: report.caseSummary as CaseSummary, cached: true };
  }

  // Coalesce concurrent generations of the same (report, inputs): the
  // inspector panel can mount twice in quick succession and two tabs can
  // open the same case — one model call serves them all. `force` always
  // starts a fresh call (that is what the user asked for) but still
  // registers it so followers join it rather than paying again.
  const inflightKey = `${report.id}:${inputsHash}`;
  const existing = options.force ? undefined : inflight.get(inflightKey);
  if (existing) {
    debug('CaseSummary', `joining in-flight summary for report ${report.id}`);
    return existing;
  }
  const run = generateFresh(report, inputs, inputsHash, options).finally(() => {
    if (inflight.get(inflightKey) === run) inflight.delete(inflightKey);
  });
  inflight.set(inflightKey, run);
  return run;
}

const inflight = new Map<string, Promise<GenerateCaseSummaryResult>>();

async function generateFresh(
  report: TestCaseRun,
  inputs: CaseSummaryInputs,
  inputsHash: string,
  options: GenerateCaseSummaryOptions
): Promise<GenerateCaseSummaryResult> {
  const modelId = resolveRegionAwareModelId(getCaseSummaryModelId());
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CASE_SUMMARY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const command = new ConverseCommand({
      modelId,
      system: [{ text: CASE_SUMMARY_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: buildCaseSummaryPrompt(inputs) }] }],
      inferenceConfig: buildInferenceConfig(modelId, { maxTokens: 600, temperature: 0.1 }),
    });
    debug('CaseSummary', `Generating summary for report ${report.id} via ${modelId} (hash ${inputsHash})`);
    const response = await getBedrockClient().send(command, { abortSignal: controller.signal });
    let responseText = '';
    for (const block of response.output?.message?.content ?? []) {
      if ('text' in block && block.text) responseText += block.text;
    }
    if (!responseText) throw new Error('Empty response from summary model');
    const parts = parseCaseSummaryResponse(responseText);
    const summary: CaseSummary = {
      source: 'llm',
      parts,
      text: partsToText(parts),
      model: modelId,
      generatedAt: new Date().toISOString(),
      inputsHash,
    };
    if (options.persist) {
      try {
        await options.persist(summary);
      } catch (err: any) {
        // A persistence hiccup must not hide a perfectly good summary.
        console.warn(`[CaseSummary] Failed to cache summary for report ${report.id}: ${err?.message || err}`);
      }
    }
    return { summary, cached: false };
  } catch (err: any) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? `summary model did not answer within ${Math.round(timeoutMs / 1000)} s`
      : (err?.message || String(err));
    debug('CaseSummary', `LLM summary failed for report ${report.id}: ${message}`);
    console.warn(`[CaseSummary] model summary unavailable for report ${report.id} — ${message}; returning field-based summary`);
    return { summary: buildFallbackSummary(inputs, message), cached: false };
  } finally {
    clearTimeout(timer);
  }
}
