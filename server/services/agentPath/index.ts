/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public API for the agent-path module.
 *
 * Two top-level entry points cover the two consumer kinds:
 *
 *   - `getAgentSourceForPrompt()` is for tools-incapable judges and the
 *     fallback assistant path: it runs all three phases and returns a
 *     ready-to-inject markdown block.
 *
 *   - `getAgentPathForSpawn()` is for tools-capable judges (claude-code,
 *     pi, agentic) and the assistant's Claude CLI path: it returns the
 *     agent path string so the caller can spawn the child process with
 *     `cwd: agentPath`. The child then has full filesystem access via its
 *     own Read/Grep/Glob tools.
 */

import type { TrajectoryStep } from '@/types';
import { resolveAgentPath, isAgentPathConfigured, hasAgentPathEnv } from './path';
import { discoverAgentPath, renderDiscoveryMarkdown } from './discover';
import { getRelevantAgentFiles, renderRetrievalMarkdown } from './retrieve';
import { gatherAgentFiles, renderGatherMarkdown, isGatherEnabled } from './gather';
import { debug } from '@/lib/debug';

export {
  resolveAgentPath,
  isAgentPathConfigured,
  hasAgentPathEnv,
} from './path';
export { discoverAgentPath, renderDiscoveryMarkdown, MARKER_FILES } from './discover';
export type { AgentPathDiscovery, AgentPathTreeEntry } from './discover';
export { getRelevantAgentFiles, renderRetrievalMarkdown, extractIdentifiers } from './retrieve';
export type { RetrievalResult } from './retrieve';
export { gatherAgentFiles, renderGatherMarkdown, isGatherEnabled } from './gather';
export type { GatherResult, GatherInvoker } from './gather';

// ============================================================================
// Combined entry points
// ============================================================================

/**
 * Build the markdown block to inject under `## Agent Source` in a judge or
 * assistant prompt. Runs all three phases. Returns `null` when no agent
 * path is configured (feature dormant).
 *
 * Safe to call without setting AH_AGENT_PATH — fast path returns null
 * without doing any work.
 */
export async function getAgentSourceForPrompt(params: {
  trajectory: TrajectoryStep[];
  expectedOutcomes?: string[];
  /** Judge model id, used for Phase 3's LLM call. */
  modelId?: string;
}): Promise<string | null> {
  const rootPath = resolveAgentPath();
  if (!rootPath) return null;

  const sections: string[] = [];

  // Phase 1
  const discovery = discoverAgentPath(rootPath);
  const phase1 = renderDiscoveryMarkdown(discovery);
  if (phase1) sections.push(phase1);

  // Phase 2
  const retrieval = getRelevantAgentFiles(rootPath, params.trajectory, params.expectedOutcomes);
  const phase2 = renderRetrievalMarkdown(retrieval);
  if (phase2) sections.push(phase2);

  // Phase 3 (only if configured + gain expected, and we have a model id).
  if (params.modelId && isGatherEnabled()) {
    try {
      const gather = await gatherAgentFiles({
        rootPath,
        trajectory: params.trajectory,
        expectedOutcomes: params.expectedOutcomes,
        modelId: params.modelId,
        phase2FileCount: retrieval.files.length,
      });
      const phase3 = renderGatherMarkdown(gather);
      if (phase3) sections.push(phase3);
    } catch (err: any) {
      // Phase 3 is best-effort; never block on its failure.
      debug('AgentPath', `Phase 3 swallowed: ${err?.message || err}`);
    }
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

/**
 * For tools-capable consumers (Claude / Pi / agentic CLIs and the AI
 * assistant's Claude CLI session). Returns the agent path to use as
 * `cwd:` when spawning a child process, or `null` when the feature is
 * dormant.
 */
export function getAgentPathForSpawn(): string | null {
  return resolveAgentPath();
}
