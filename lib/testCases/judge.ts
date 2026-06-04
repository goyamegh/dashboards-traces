/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `judge()` — LLM-judge matcher, callable from inside a test body.
 *
 * Two ergonomic forms:
 *
 *   await judge(result, 'identifies the failing dependency');         // single claim
 *   await judge(result.trajectory, ['claim 1', 'claim 2']);            // legacy form
 *
 * On pass: returns a JudgeVerdict and records a MatcherResult.
 * On fail: throws (so the test body bails out) and records a failed
 * MatcherResult before throwing.
 *
 * Calls the Agent Health server's /api/judge endpoint.
 */

import type { TrajectoryStep } from '@/types';
import { recordVerdict } from '../matchers/session.js';

export interface JudgeVerdict {
  passFailStatus: 'passed' | 'failed';
  accuracy: number;
  reasoning: string;
}

let judgeCalledInCurrentEval = false;

export function wasJudgeCalled(): boolean {
  return judgeCalledInCurrentEval;
}

export function resetJudgeFlag(): void {
  judgeCalledInCurrentEval = false;
}

interface ResultLike {
  trajectory?: TrajectoryStep[];
  finalResponse?: () => string;
  agentOutput?: string;
}

function isTrajectory(x: unknown): x is TrajectoryStep[] {
  return Array.isArray(x);
}

function isResultLike(x: unknown): x is ResultLike {
  return typeof x === 'object' && x !== null && 'trajectory' in (x as object);
}

/**
 * Single-claim ergonomic form.
 * @example
 *   await judge(result, 'identifies the failing dependency');
 */
export async function judge(
  resultOrTrajectory: ResultLike | TrajectoryStep[],
  claimOrClaims: string | string[],
  options?: { serverUrl?: string; model?: string }
): Promise<JudgeVerdict> {
  judgeCalledInCurrentEval = true;

  const trajectory = isTrajectory(resultOrTrajectory)
    ? resultOrTrajectory
    : (isResultLike(resultOrTrajectory) ? resultOrTrajectory.trajectory ?? [] : []);
  const claims = Array.isArray(claimOrClaims) ? claimOrClaims : [claimOrClaims];

  const serverUrl =
    options?.serverUrl ?? `http://localhost:${process.env.AGENT_HEALTH_PORT ?? '4001'}`;

  const description =
    claims.length === 1 ? `judge: ${claims[0]}` : `judge: ${claims.length} claims`;

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trajectory,
        expectedOutcomes: claims,
        expectedTrajectory: [],
        model: options?.model,
      }),
    });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge request failed: ${errMsg}`,
      reasoning: '',
    });
    throw new Error(`Judge request failed: ${errMsg}`);
  }

  if (!response.ok) {
    const text = await response.text();
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge HTTP ${response.status}: ${text}`,
      reasoning: '',
    });
    throw new Error(`Judge request failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as any;
  const verdict: JudgeVerdict = {
    passFailStatus: result.passFailStatus ?? 'failed',
    accuracy: result.metrics?.accuracy ?? 0,
    reasoning: result.llmJudgeReasoning ?? '',
  };

  // Record once for the overall judge call.
  recordVerdict({
    description,
    pass: verdict.passFailStatus === 'passed',
    method: 'llm-judge',
    durationMs: Date.now() - startedAt,
    score: typeof verdict.accuracy === 'number' ? verdict.accuracy / 100 : undefined,
    reasoning: verdict.reasoning,
    model: options?.model,
    errorMessage: verdict.passFailStatus === 'failed' ? verdict.reasoning : undefined,
    // Preserve the rest of the judge payload — these were silently
    // dropped before, which made SDK `judge()` calls strictly less
    // informative than the legacy auto-judge path. See MatcherResult.
    ...(Array.isArray(result.improvementStrategies) && result.improvementStrategies.length > 0
      ? { improvementStrategies: result.improvementStrategies }
      : {}),
    ...(result.metrics && typeof result.metrics === 'object'
      ? { judgeMetrics: { ...result.metrics } }
      : {}),
  });

  if (verdict.passFailStatus === 'failed') {
    throw new Error(`LLM Judge: FAILED (accuracy: ${verdict.accuracy})\n${verdict.reasoning}`);
  }

  return verdict;
}
