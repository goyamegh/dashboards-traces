/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matcher session — collects MatcherResult[] for the currently-executing
 * test body. The runner sets the active session before invoking the body
 * and reads it back afterwards. Matchers (expect/judge/traces) record
 * into the session via `recordVerdict`.
 *
 * One session per test case execution. Sessions are not nested.
 */

import type { MatcherResult, MatcherMethod } from './types.js';

let activeSession: MatcherSession | null = null;

export interface MatcherSession {
  results: MatcherResult[];
  startedAt: number;
}

/** Begin a fresh session and make it the active one. */
export function startSession(): MatcherSession {
  const session: MatcherSession = { results: [], startedAt: Date.now() };
  activeSession = session;
  return session;
}

/** Stop the current session and return its results. */
export function endSession(): MatcherResult[] {
  if (!activeSession) return [];
  const out = activeSession.results;
  activeSession = null;
  return out;
}

/** True when a session is active (i.e. we're inside a test body). */
export function isSessionActive(): boolean {
  return activeSession !== null;
}

/** Record a single matcher verdict on the active session. No-op when no session. */
export function recordVerdict(result: MatcherResult): void {
  if (!activeSession) return;
  activeSession.results.push(result);
}

/**
 * Record a verdict computed from a try/catch around the matcher body.
 * Convenience wrapper used by judge() and traces helpers; chai matchers go
 * through the chai plugin in `./expect.ts`.
 */
export async function recordWithTiming<T>(
  description: string,
  method: MatcherMethod,
  fn: () => Promise<T> | T
): Promise<T> {
  const start = Date.now();
  try {
    const value = await fn();
    recordVerdict({
      description,
      pass: true,
      method,
      durationMs: Date.now() - start,
    });
    return value;
  } catch (err: any) {
    recordVerdict({
      description,
      pass: false,
      method,
      durationMs: Date.now() - start,
      errorMessage: err?.message || String(err),
    });
    throw err;
  }
}
