/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 1: Discover.
 *
 * Walks the configured agent path producing:
 *   - A pruned file tree (filenames + sizes, gitignore-aware, well-known
 *     ignores skipped). This is the "table of contents" the judge / agent
 *     uses to understand the repo's layout at a glance.
 *   - Marker files read in full: AGENTS.md, AGENT.md, CLAUDE.md, README.md,
 *     package.json, pyproject.toml, Cargo.toml, go.mod. These describe
 *     the project's intent, dependencies, and conventions.
 *
 * Both are cached per agent-path for the lifetime of the process — the
 * marker files don't change between judge calls in a single benchmark run.
 *
 * The result is bounded: file tree caps at MAX_TREE_ENTRIES paths, marker
 * files cap at MAX_MARKER_BYTES total. Beyond the cap we truncate and
 * mark the result as such — never throw.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { debug } from '@/lib/debug';

// ============================================================================
// Constants
// ============================================================================

/** Marker files read in full when present at the agent-path root. */
export const MARKER_FILES = [
  'AGENTS.md',
  'AGENT.md',
  'CLAUDE.md',
  'README.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
] as const;

/** Directories whose contents are always skipped during the file-tree walk. */
const ALWAYS_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.vite',
  'coverage',
  '.coverage',
  '.nyc_output',
  '.pytest_cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.npm',
  'agent-health-data',
  'playwright-report',
  'test-results',
]);

/** File extensions skipped during the walk (binary / generated). */
const ALWAYS_IGNORED_EXTS = new Set([
  '.log',
  '.lock',
  '.tsbuildinfo',
  '.map',
  '.min.js',
  '.min.css',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.mp3',
  '.mp4',
  '.mov',
  '.webm',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

/** Hard caps on the discovery output. */
const MAX_TREE_ENTRIES = 500;
const MAX_MARKER_BYTES = 100_000;
const MAX_WALK_DEPTH = 10;

// ============================================================================
// Types
// ============================================================================

export interface AgentPathTreeEntry {
  /** path relative to the agent-path root, using forward slashes */
  path: string;
  /** size in bytes (0 for directories) */
  size: number;
  /** true when this entry is a directory */
  isDirectory: boolean;
}

export interface AgentPathDiscovery {
  /** Absolute agent-path root that was scanned. */
  rootPath: string;
  /** Pruned, alphabetically sorted file tree. */
  tree: AgentPathTreeEntry[];
  /** Whether the tree was capped at MAX_TREE_ENTRIES. */
  treeTruncated: boolean;
  /** Marker files keyed by relative path (e.g., 'AGENTS.md' → contents). */
  markers: Record<string, string>;
  /** Whether any marker file content was truncated to fit the byte cap. */
  markersTruncated: boolean;
  /** Total bytes used by all marker file contents. */
  markersTotalBytes: number;
}

// ============================================================================
// Cache
// ============================================================================

const cache = new Map<string, AgentPathDiscovery>();

/** TEST-ONLY: clear the discovery cache. */
export function _resetDiscoveryCacheForTests(): void {
  cache.clear();
}

// ============================================================================
// Implementation
// ============================================================================

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') ? ALWAYS_IGNORED_DIRS.has(name) : ALWAYS_IGNORED_DIRS.has(name);
}

function shouldSkipFile(name: string): boolean {
  // hidden dotfiles other than well-known config like .env / .gitignore
  // are skipped to keep the tree compact
  if (name.startsWith('.') && !['.env', '.gitignore', '.gitattributes', '.editorconfig'].includes(name)) {
    return true;
  }
  for (const ext of ALWAYS_IGNORED_EXTS) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

function walkTree(rootPath: string): { tree: AgentPathTreeEntry[]; truncated: boolean } {
  const tree: AgentPathTreeEntry[] = [];
  let truncated = false;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_WALK_DEPTH) continue;
    if (tree.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // permission denied / vanished — keep going
    }

    entries.sort();

    for (const name of entries) {
      if (tree.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        const rel = relative(rootPath, full).split(/[\\/]/).join('/');
        tree.push({ path: rel + '/', size: 0, isDirectory: true });
        stack.push({ dir: full, depth: depth + 1 });
      } else if (s.isFile()) {
        if (shouldSkipFile(name)) continue;
        const rel = relative(rootPath, full).split(/[\\/]/).join('/');
        tree.push({ path: rel, size: s.size, isDirectory: false });
      }
    }
  }

  // sort for deterministic output
  tree.sort((a, b) => a.path.localeCompare(b.path));
  return { tree, truncated };
}

function readMarkers(rootPath: string): {
  markers: Record<string, string>;
  truncated: boolean;
  totalBytes: number;
} {
  const markers: Record<string, string> = {};
  let totalBytes = 0;
  let truncated = false;

  for (const name of MARKER_FILES) {
    const full = join(rootPath, name);
    if (!existsSync(full)) continue;

    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue; // unreadable — skip
    }

    if (totalBytes + content.length > MAX_MARKER_BYTES) {
      const remaining = MAX_MARKER_BYTES - totalBytes;
      if (remaining > 200) {
        markers[name] = content.slice(0, remaining) + '\n\n... [truncated]';
        totalBytes += remaining;
      }
      truncated = true;
      break;
    }
    markers[name] = content;
    totalBytes += content.length;
  }

  return { markers, truncated, totalBytes };
}

/**
 * Discover the agent-path: pruned file tree + marker files. Cached per
 * agent path for the lifetime of the process.
 */
export function discoverAgentPath(rootPath: string): AgentPathDiscovery {
  const cached = cache.get(rootPath);
  if (cached) return cached;

  debug('AgentPath', `Discovering ${rootPath}`);
  const { tree, truncated: treeTruncated } = walkTree(rootPath);
  const { markers, truncated: markersTruncated, totalBytes } = readMarkers(rootPath);

  const result: AgentPathDiscovery = {
    rootPath,
    tree,
    treeTruncated,
    markers,
    markersTruncated,
    markersTotalBytes: totalBytes,
  };
  cache.set(rootPath, result);
  debug(
    'AgentPath',
    `Discovered ${tree.length} entries, ${Object.keys(markers).length} markers ` +
      `(${totalBytes} bytes)${treeTruncated ? ' [tree truncated]' : ''}` +
      `${markersTruncated ? ' [markers truncated]' : ''}`,
  );
  return result;
}

/**
 * Render the discovery as a markdown block ready to inject into a prompt.
 * Returns the empty string when discovery has no useful content.
 */
export function renderDiscoveryMarkdown(d: AgentPathDiscovery): string {
  if (d.tree.length === 0 && Object.keys(d.markers).length === 0) return '';

  const parts: string[] = [];
  parts.push(`### Repository overview`);
  parts.push(`Source path: \`${d.rootPath}\``);

  if (Object.keys(d.markers).length > 0) {
    parts.push('');
    parts.push(`### Marker files`);
    for (const [name, content] of Object.entries(d.markers)) {
      parts.push('');
      parts.push(`#### ${name}`);
      parts.push('```');
      parts.push(content.trimEnd());
      parts.push('```');
    }
  }

  if (d.tree.length > 0) {
    parts.push('');
    parts.push(`### File tree (${d.tree.length} entries${d.treeTruncated ? ', truncated' : ''})`);
    parts.push('```');
    for (const entry of d.tree) {
      const kind = entry.isDirectory ? '/' : ` (${entry.size}b)`;
      parts.push(entry.path + (entry.isDirectory ? '' : kind));
    }
    parts.push('```');
  }

  return parts.join('\n');
}
