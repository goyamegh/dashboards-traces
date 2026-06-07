/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3: Agentic gatherer.
 *
 * One LLM call to the configured judge model with the file tree, marker
 * files, and trajectory summary. The model picks up to MAX_FILES paths it
 * thinks are most relevant to evaluating this run; we read those and
 * return them.
 *
 * Triggered ONLY when Phase 2 returned fewer than PHASE3_THRESHOLD files,
 * because Phase 2 is cheaper and usually sufficient. Set
 * AH_AGENT_GATHER=off to disable Phase 3 entirely.
 *
 * The model used here is the same one configured for the judge — passed
 * in by the caller — so users don't need a separate API key.
 *
 * Returns an empty result on any failure (network, JSON parse, missing
 * files). The judge always has Phase 1 + 2 to fall back on; Phase 3 is
 * additive, never load-bearing.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { debug } from '@/lib/debug';
import { discoverAgentPath } from './discover';
import type { TrajectoryStep } from '@/types';

// ============================================================================
// Constants
// ============================================================================

/** Threshold below which Phase 3 fires. Set to 2 by default. */
const PHASE3_THRESHOLD = 2;
/** Maximum files Phase 3 may return. */
const MAX_FILES = 5;
/** Per-file byte cap (same as Phase 2 to keep budgets aligned). */
const MAX_FILE_BYTES = 50_000;
/** Total byte cap for Phase 3 inlined files. */
const MAX_TOTAL_BYTES = 80_000;
/** Max chars of trajectory summary fed to the gatherer. */
const TRAJECTORY_SUMMARY_CHARS = 4_000;

const GATHERER_SYSTEM_PROMPT = `You are a file-selection assistant. Given an agent's
source-tree listing and a summary of an execution trajectory, return the
file paths most relevant to evaluating that trajectory. Output JSON only:

{"files": ["src/foo.py", "tools/bar.ts"]}

Rules:
- Return up to ${MAX_FILES} paths. Fewer is fine.
- Paths must be exact entries from the provided file tree (no guessing).
- Prefer files that define tools, prompts, or modules referenced in the
  trajectory.
- Skip generated files, lockfiles, tests, and build artifacts.
- If nothing in the tree looks relevant, return {"files": []}.

Output JSON and nothing else. No markdown fences, no commentary.`;

// ============================================================================
// Types
// ============================================================================

export interface GatherResult {
  files: Array<{ path: string; content: string }>;
  /** Whether Phase 3 actually ran (false when below threshold or disabled). */
  ran: boolean;
  /** Set when the LLM call or JSON parse failed; result is best-effort. */
  errorReason?: string;
}

/**
 * Plug a different LLM caller for testing. Defaults to a thin Bedrock
 * Converse wrapper at runtime; tests inject a mock.
 */
export type GatherInvoker = (params: {
  systemPrompt: string;
  userPrompt: string;
  modelId: string;
}) => Promise<string>;

// ============================================================================
// Default invoker (Bedrock Converse, used in production)
// ============================================================================

let cachedDefaultInvoker: GatherInvoker | null = null;

async function getDefaultInvoker(): Promise<GatherInvoker> {
  if (cachedDefaultInvoker) return cachedDefaultInvoker;

  // Lazy import so unit tests that mock or skip Phase 3 don't pay the cost.
  const { BedrockRuntimeClient, ConverseCommand } = await import(
    '@aws-sdk/client-bedrock-runtime'
  );
  const config = (await import('@/server/config')).default;

  const client = new BedrockRuntimeClient({ region: config.AWS_REGION });

  cachedDefaultInvoker = async ({ systemPrompt, userPrompt, modelId }) => {
    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: 512, temperature: 0 },
    });
    const response = await client.send(command);
    let text = '';
    for (const c of response.output?.message?.content ?? []) {
      if ('text' in c && c.text) text += c.text;
    }
    return text;
  };
  return cachedDefaultInvoker;
}

// ============================================================================
// Helpers
// ============================================================================

function summarizeTrajectory(
  trajectory: TrajectoryStep[],
  expectedOutcomes?: string[],
): string {
  const lines: string[] = [];
  if (expectedOutcomes?.length) {
    lines.push('Expected outcomes:');
    for (const o of expectedOutcomes) lines.push(`- ${o}`);
    lines.push('');
  }
  lines.push('Trajectory steps:');
  for (let i = 0; i < trajectory.length; i++) {
    const s = trajectory[i];
    const tool = s.toolName ? `[${s.toolName}]` : `[${s.type}]`;
    const content =
      typeof s.content === 'string' ? s.content.slice(0, 200).replace(/\s+/g, ' ') : '';
    lines.push(`${i + 1}. ${tool} ${content}`);
  }
  const all = lines.join('\n');
  return all.length > TRAJECTORY_SUMMARY_CHARS
    ? all.slice(0, TRAJECTORY_SUMMARY_CHARS) + '\n... [truncated]'
    : all;
}

function parseFileList(raw: string): string[] {
  // The model is asked for raw JSON, but tolerate ```json fences.
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).files)) {
    return [];
  }
  return ((parsed as any).files as unknown[])
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .slice(0, MAX_FILES);
}

// ============================================================================
// Public API
// ============================================================================

/** Whether Phase 3 is enabled (env opt-out: AH_AGENT_GATHER=off). */
export function isGatherEnabled(): boolean {
  const raw = process.env.AH_AGENT_GATHER?.trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/**
 * Run Phase 3 if conditions warrant. Returns ran=false when:
 *   - Phase 2 already returned >= PHASE3_THRESHOLD files
 *   - AH_AGENT_GATHER=off
 *   - the discovery tree is empty (nothing to gather from)
 */
export async function gatherAgentFiles(params: {
  rootPath: string;
  trajectory: TrajectoryStep[];
  expectedOutcomes?: string[];
  modelId: string;
  phase2FileCount: number;
  invoker?: GatherInvoker;
}): Promise<GatherResult> {
  const { rootPath, trajectory, expectedOutcomes, modelId, phase2FileCount } = params;

  if (!isGatherEnabled()) {
    debug('AgentPath', 'Phase 3 skipped: AH_AGENT_GATHER=off');
    return { files: [], ran: false };
  }
  if (phase2FileCount >= PHASE3_THRESHOLD) {
    debug('AgentPath', `Phase 3 skipped: phase2 found ${phase2FileCount} files (>= ${PHASE3_THRESHOLD})`);
    return { files: [], ran: false };
  }

  const discovery = discoverAgentPath(rootPath);
  if (discovery.tree.length === 0) {
    return { files: [], ran: false };
  }

  // Build the user prompt.
  const treeListing = discovery.tree
    .filter(e => !e.isDirectory)
    .map(e => e.path)
    .join('\n');
  const userPrompt = [
    '## File tree',
    '```',
    treeListing,
    '```',
    '',
    '## Trajectory summary',
    summarizeTrajectory(trajectory, expectedOutcomes),
  ].join('\n');

  const invoker = params.invoker ?? (await getDefaultInvoker());

  let raw: string;
  try {
    raw = await invoker({
      systemPrompt: GATHERER_SYSTEM_PROMPT,
      userPrompt,
      modelId,
    });
  } catch (err: any) {
    debug('AgentPath', `Phase 3 LLM call failed: ${err?.message || err}`);
    return { files: [], ran: true, errorReason: `llm_call_failed: ${err?.message || err}` };
  }

  const candidatePaths = parseFileList(raw);
  if (candidatePaths.length === 0) {
    return { files: [], ran: true };
  }

  // Validate each path is in the tree, then read.
  const validPaths = new Set(discovery.tree.filter(e => !e.isDirectory).map(e => e.path));
  const files: GatherResult['files'] = [];
  let totalBytes = 0;
  for (const p of candidatePaths) {
    if (!validPaths.has(p)) continue;
    if (files.length >= MAX_FILES) break;
    const full = join(rootPath, p);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    if (totalBytes + size > MAX_TOTAL_BYTES) break;

    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    files.push({ path: p, content });
    totalBytes += size;
  }

  debug(
    'AgentPath',
    `Phase 3: requested=${candidatePaths.length}, returned=${files.length}, bytes=${totalBytes}`,
  );
  return { files, ran: true };
}

/**
 * Render Phase 3 result as a markdown block for prompt injection.
 */
export function renderGatherMarkdown(g: GatherResult): string {
  if (g.files.length === 0) return '';
  const parts: string[] = [];
  parts.push('### Additional files selected by gatherer');
  for (const f of g.files) {
    parts.push('');
    parts.push(`#### ${f.path}`);
    parts.push('```');
    parts.push(f.content.trimEnd());
    parts.push('```');
  }
  return parts.join('\n');
}

/** TEST-ONLY: clear cached default invoker so tests can re-mock. */
export function _resetDefaultInvokerForTests(): void {
  cachedDefaultInvoker = null;
}
