/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';

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

/**
 * Invoke the LLM judge from within an evaluate() function.
 * Calls the Agent Health server's judge endpoint.
 *
 * Requires the Agent Health server to be running.
 */
export async function judge(
  trajectory: TrajectoryStep[],
  expectedOutcomes: string[],
  options?: { serverUrl?: string }
): Promise<JudgeVerdict> {
  judgeCalledInCurrentEval = true;

  const serverUrl = options?.serverUrl ?? `http://localhost:${process.env.AGENT_HEALTH_PORT ?? '4001'}`;

  const response = await fetch(`${serverUrl}/api/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trajectory,
      expectedOutcomes,
      expectedTrajectory: [],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Judge request failed (${response.status}): ${text}`);
  }

  const result = await response.json() as any;
  const verdict: JudgeVerdict = {
    passFailStatus: result.passFailStatus ?? 'failed',
    accuracy: result.metrics?.accuracy ?? 0,
    reasoning: result.llmJudgeReasoning ?? '',
  };

  if (verdict.passFailStatus === 'failed') {
    throw new Error(`LLM Judge: FAILED (accuracy: ${verdict.accuracy})\n${verdict.reasoning}`);
  }

  return verdict;
}
