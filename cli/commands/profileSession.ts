/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-id resolution for the `profile` command.
 *
 * Kept in its own module (only fs/path/os deps) so it can be unit-tested
 * without importing the command's server/config machinery.
 *
 * Resolution order (first hit wins):
 *  1. explicit `--session`
 *  2. `.pi/agent-health/current-session`     — written by the agent-health-profile
 *     pi extension on session_start (exact, agent='pi')
 *  3. `.claude/agent-health/current-session` — written by the `agent-health setup`
 *     Claude Code hook (exact, agent='claude')
 *  4. newest Claude Code transcript for this cwd (heuristic, agent='claude')
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Marker files each integration writes so `profile` finds the live session. */
export const CLAUDE_SESSION_FILE = join('.claude', 'agent-health', 'current-session');
export const PI_SESSION_FILE = join('.pi', 'agent-health', 'current-session');

export type ProfileAgent = 'claude' | 'pi' | undefined;

export interface ResolvedSession {
  sessionId: string | null;
  source: string;
  agent: ProfileAgent;
}

export function resolveSessionId(explicit?: string): ResolvedSession {
  if (explicit) return { sessionId: explicit, source: 'flag', agent: undefined };

  if (existsSync(PI_SESSION_FILE)) {
    const id = readFileSync(PI_SESSION_FILE, 'utf-8').trim();
    if (id) return { sessionId: id, source: 'pi-extension', agent: 'pi' };
  }

  if (existsSync(CLAUDE_SESSION_FILE)) {
    const id = readFileSync(CLAUDE_SESSION_FILE, 'utf-8').trim();
    if (id) return { sessionId: id, source: 'hook', agent: 'claude' };
  }

  // Heuristic fallback: ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl,
  // newest by mtime. cwd-slug = cwd with non-alphanumerics → '-'.
  try {
    const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
    const dir = join(homedir(), '.claude', 'projects', slug);
    if (existsSync(dir)) {
      const newest = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) return { sessionId: newest.f.replace(/\.jsonl$/, ''), source: 'transcript', agent: 'claude' };
    }
  } catch {
    /* ignore — fall through to null */
  }

  return { sessionId: null, source: 'none', agent: undefined };
}
