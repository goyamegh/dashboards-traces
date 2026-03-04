/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-Turn Judge System Prompt
 *
 * Instructs the LLM to evaluate an agent's performance across a multi-turn
 * investigation conversation. Scores four dimensions holistically rather
 * than per-turn.
 */

import type { ConversationTurnRecord } from '@/types';

/** Default scoring weights (must sum to 100) */
export const DEFAULT_SCORING_WEIGHTS = {
  rootCause: 40,
  remediation: 30,
  contextRetention: 20,
  conciseness: 10,
};

export interface MultiTurnJudgeInput {
  turns: ConversationTurnRecord[];
  idealAnswer: string;
  criticalComponents?: {
    rootCause: string;
    remediation: string;
  };
  scoringWeights?: {
    rootCause?: number;
    remediation?: number;
    contextRetention?: number;
    conciseness?: number;
  };
}

export interface MultiTurnJudgeOutput {
  root_cause_score: number;
  remediation_score: number;
  context_retention_score: number;
  conciseness_score: number;
  pass_fail_status: 'passed' | 'failed';
  reasoning: string;
  improvement_strategies: Array<{
    category: string;
    issue: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}

/**
 * Build the system prompt for multi-turn holistic evaluation.
 */
export function buildMultiTurnJudgeSystemPrompt(input: MultiTurnJudgeInput): string {
  const weights = {
    ...DEFAULT_SCORING_WEIGHTS,
    ...input.scoringWeights,
  };

  const conversationText = input.turns
    .map(turn => `### Turn ${turn.turn}\n**User:** ${turn.userMessage}\n**Agent:** ${turn.agentResponse}`)
    .join('\n\n');

  const criticalSection = input.criticalComponents
    ? `## Critical Components
- Root cause: ${input.criticalComponents.rootCause}
- Remediation: ${input.criticalComponents.remediation}`
    : '';

  return `You are evaluating an agent's performance in a multi-turn investigation.

## Ideal Answer
${input.idealAnswer}

${criticalSection}

## Full Conversation
${conversationText}

## Scoring (score each 0-100)

1. Root Cause Identification (weight: ${weights.rootCause}%)
   Did the agent correctly identify the root cause? Compare with the ideal answer.

2. Remediation Correctness (weight: ${weights.remediation}%)
   Did the agent recommend the correct fix? Was it actionable?

3. Context Retention (weight: ${weights.contextRetention}%)
   Did the agent maintain context across turns? Did later answers build on earlier findings?
   Did it avoid contradicting itself?

4. Conciseness & Actionability (weight: ${weights.conciseness}%)
   Were responses clear, concise, and actionable? Did the agent avoid unnecessary verbosity?

## Output (JSON)

You MUST respond with this JSON structure:

\`\`\`json
{
  "root_cause_score": <0-100>,
  "remediation_score": <0-100>,
  "context_retention_score": <0-100>,
  "conciseness_score": <0-100>,
  "pass_fail_status": "passed" | "failed",
  "reasoning": "<holistic explanation>",
  "improvement_strategies": [
    {
      "category": "<category>",
      "issue": "<description>",
      "recommendation": "<suggestion>",
      "priority": "high" | "medium" | "low"
    }
  ]
}
\`\`\`

Pass threshold: weighted_score >= 70
weighted_score = (root_cause_score * ${weights.rootCause} + remediation_score * ${weights.remediation} + context_retention_score * ${weights.contextRetention} + conciseness_score * ${weights.conciseness}) / 100

IMPORTANT:
- Score each dimension independently
- The pass_fail_status should reflect the weighted score threshold
- Be specific in reasoning about which turns showed strength or weakness
- Always include improvement_strategies (can be empty for excellent performance)`;
}

/**
 * Compute the weighted score from individual dimension scores.
 */
export function computeWeightedScore(
  scores: {
    rootCauseScore: number;
    remediationScore: number;
    contextRetentionScore: number;
    concisenessScore: number;
  },
  weights?: {
    rootCause?: number;
    remediation?: number;
    contextRetention?: number;
    conciseness?: number;
  }
): number {
  const w = { ...DEFAULT_SCORING_WEIGHTS, ...weights };
  return (
    scores.rootCauseScore * w.rootCause +
    scores.remediationScore * w.remediation +
    scores.contextRetentionScore * w.contextRetention +
    scores.concisenessScore * w.conciseness
  ) / 100;
}
