/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 2: Heuristic relevance retrieval.
 *
 * Given a trajectory + expected outcomes, extract identifiers (tool names,
 * file paths, module references, etc.) and grep the agent path's file tree
 * for matches. Read the top-N matched files and return them as a markdown
 * block.
 *
 * Cheap and deterministic — no LLM call. Works well when trajectory tool
 * names map to file or class names in the user's repo (the common case
 * for typed tool-call schemas like AG-UI).
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { debug } from '@/lib/debug';
import { discoverAgentPath } from './discover';
import type { TrajectoryStep } from '@/types';

// ============================================================================
// Constants
// ============================================================================

/** Files larger than this are skipped to keep the prompt budget sane. */
const MAX_FILE_BYTES = 50_000;
/** Total byte budget for retrieved file contents. */
const MAX_TOTAL_BYTES = 80_000;
/** Maximum number of files to inline. */
const MAX_FILES = 5;

/**
 * Stop-words and tokens too generic to be useful as grep needles.
 * Lower-case for case-insensitive comparison.
 */
const STOP_TOKENS = new Set([
  'and', 'or', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of',
  'in', 'on', 'for', 'with', 'by', 'as', 'at', 'be', 'been', 'this',
  'that', 'it', 'its', 'from', 'into', 'about', 'over', 'true', 'false',
  'null', 'undefined', 'function', 'class', 'method', 'tool', 'tools',
  'agent', 'agents', 'name', 'value', 'data', 'result', 'response',
  'error', 'errors', 'success', 'failure', 'string', 'number', 'object',
  'array', 'boolean', 'type', 'types', 'json', 'yaml', 'xml', 'http',
  'https', 'get', 'post', 'put', 'delete', 'request', 'requests',
  'message', 'messages', 'output', 'input',
]);

// ============================================================================
// Types
// ============================================================================

export interface RetrievalResult {
  /** Files inlined into the prompt, keyed by relative path. */
  files: Array<{ path: string; content: string }>;
  /** All identifiers extracted from the trajectory (for debugging / logs). */
  identifiers: string[];
  /** True when matches existed but byte cap forced us to skip some files. */
  truncated: boolean;
}

// ============================================================================
// Identifier extraction
// ============================================================================

/**
 * Extract candidate identifiers from a trajectory + expected outcomes.
 * Identifiers are tokens likely to appear verbatim in source code:
 *  - tool names from trajectory steps
 *  - quoted strings in expected outcomes
 *  - snake_case / camelCase tokens that aren't stop words
 *  - explicit file paths (./foo/bar.py, src/x.ts, etc.)
 */
export function extractIdentifiers(
  trajectory: TrajectoryStep[],
  expectedOutcomes?: string[],
): string[] {
  const acc = new Set<string>();

  // Tool names called in the trajectory (highest signal).
  for (const step of trajectory) {
    if (step.toolName) acc.add(step.toolName);
  }

  const allText: string[] = [];
  for (const step of trajectory) {
    if (typeof step.content === 'string') allText.push(step.content);
    if (typeof (step as any).toolInput === 'string') {
      allText.push((step as any).toolInput);
    }
  }
  if (expectedOutcomes) {
    for (const outcome of expectedOutcomes) allText.push(outcome);
  }

  const text = allText.join('\n');

  // Backtick-quoted identifiers: `search_logs`, `MyClass`, `./foo.py`.
  const backticked = text.match(/`([^`]+)`/g);
  if (backticked) {
    for (const m of backticked) {
      const inner = m.slice(1, -1).trim();
      if (inner.length >= 3 && inner.length <= 80) acc.add(inner);
    }
  }

  // Quoted strings: "search_logs", 'MyClass'.
  const quoted = text.match(/"([^"\\]+)"|'([^'\\]+)'/g);
  if (quoted) {
    for (const m of quoted) {
      const inner = m.slice(1, -1).trim();
      if (inner.length >= 3 && inner.length <= 80) acc.add(inner);
    }
  }

  // Camel/snake/kebab tokens with at least one separator or capital — these
  // are highly likely to be identifiers in the user's repo and not English.
  const tokens = text.match(/\b[A-Za-z_][A-Za-z0-9_-]{2,}\b/g) || [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (STOP_TOKENS.has(lower)) continue;
    // Heuristic: must contain underscore, hyphen, or have at least one
    // non-leading uppercase letter to qualify as an identifier.
    if (
      tok.includes('_') ||
      tok.includes('-') ||
      /[A-Z]/.test(tok.slice(1))
    ) {
      acc.add(tok);
    }
  }

  // Explicit file paths.
  const paths = text.match(/\b[\w-]+\/[\w./-]+\b/g) || [];
  for (const p of paths) {
    if (p.length <= 100) acc.add(p);
  }

  return [...acc];
}

// ============================================================================
// Matching
// ============================================================================

interface ScoredEntry {
  path: string;
  score: number;
}

/**
 * Score each file in the file tree by how many identifiers appear in its
 * path (cheap proxy for relevance — opening files for content-grep would
 * be slow on large repos).
 */
function rankByPathMatches(
  treePaths: string[],
  identifiers: string[],
): ScoredEntry[] {
  const lowerIds = identifiers.map(i => i.toLowerCase());
  const ranked: ScoredEntry[] = [];

  for (const path of treePaths) {
    if (path.endsWith('/')) continue; // skip directories
    const lowerPath = path.toLowerCase();
    let score = 0;
    for (const id of lowerIds) {
      if (id.length < 3) continue;
      if (lowerPath.includes(id)) score += id.length; // longer match → more weight
    }
    if (score > 0) ranked.push({ path, score });
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranked;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Run Phase 2 retrieval against the configured agent path. Returns up to
 * MAX_FILES inlined files, total budget MAX_TOTAL_BYTES.
 */
export function getRelevantAgentFiles(
  rootPath: string,
  trajectory: TrajectoryStep[],
  expectedOutcomes?: string[],
): RetrievalResult {
  const identifiers = extractIdentifiers(trajectory, expectedOutcomes);
  if (identifiers.length === 0) {
    debug('AgentPath', 'Phase 2: no identifiers extracted from trajectory');
    return { files: [], identifiers: [], truncated: false };
  }

  const discovery = discoverAgentPath(rootPath);
  const ranked = rankByPathMatches(
    discovery.tree.map(t => t.path),
    identifiers,
  );

  if (ranked.length === 0) {
    debug('AgentPath', `Phase 2: no path matches for ${identifiers.length} identifiers`);
    return { files: [], identifiers, truncated: false };
  }

  const files: RetrievalResult['files'] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const { path } of ranked) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const full = join(rootPath, path);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }

    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }

    files.push({ path, content });
    totalBytes += size;
  }

  debug(
    'AgentPath',
    `Phase 2: ${files.length} files, ${totalBytes} bytes, ` +
      `${identifiers.length} identifiers${truncated ? ' [truncated]' : ''}`,
  );

  return { files, identifiers, truncated };
}

/**
 * Render Phase 2 result as a markdown block for prompt injection.
 */
export function renderRetrievalMarkdown(r: RetrievalResult): string {
  if (r.files.length === 0) return '';
  const parts: string[] = [];
  parts.push(`### Files matched to trajectory identifiers`);
  parts.push(`Identifiers used: ${r.identifiers.slice(0, 20).join(', ')}${r.identifiers.length > 20 ? ', ...' : ''}`);
  for (const f of r.files) {
    parts.push('');
    parts.push(`#### ${f.path}`);
    parts.push('```');
    parts.push(f.content.trimEnd());
    parts.push('```');
  }
  if (r.truncated) {
    parts.push('');
    parts.push('_Some matched files omitted due to size cap._');
  }
  return parts.join('\n');
}
