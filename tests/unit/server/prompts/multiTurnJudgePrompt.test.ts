/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildMultiTurnJudgeSystemPrompt,
  computeWeightedScore,
  DEFAULT_SCORING_WEIGHTS,
} from '@/server/prompts/multiTurnJudgePrompt';
import type { ConversationTurnRecord } from '@/types';

const makeTurn = (
  turn: number,
  userMessage: string,
  agentResponse: string
): ConversationTurnRecord => ({
  turn,
  userMessage,
  agentResponse,
  trajectory: [],
});

describe('multiTurnJudgePrompt', () => {
  describe('buildMultiTurnJudgeSystemPrompt', () => {
    const baseTurns: ConversationTurnRecord[] = [
      makeTurn(1, 'What caused the outage?', 'The database connection pool was exhausted.'),
      makeTurn(2, 'How do I fix it?', 'Increase the max pool size to 50 and add connection timeout settings.'),
    ];

    it('should include the ideal answer in the prompt', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'DB pool exhaustion due to leaked connections',
      });

      expect(prompt).toContain('## Ideal Answer');
      expect(prompt).toContain('DB pool exhaustion due to leaked connections');
    });

    it('should include critical components when provided', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
        criticalComponents: {
          rootCause: 'Connection pool leak in service X',
          remediation: 'Patch connection close handler',
        },
      });

      expect(prompt).toContain('## Critical Components');
      expect(prompt).toContain('Root cause: Connection pool leak in service X');
      expect(prompt).toContain('Remediation: Patch connection close handler');
    });

    it('should not include critical components section when not provided', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
      });

      expect(prompt).not.toContain('## Critical Components');
    });

    it('should include all conversation turns formatted correctly', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
      });

      expect(prompt).toContain('## Full Conversation');
      expect(prompt).toContain('### Turn 1');
      expect(prompt).toContain('**User:** What caused the outage?');
      expect(prompt).toContain('**Agent:** The database connection pool was exhausted.');
      expect(prompt).toContain('### Turn 2');
      expect(prompt).toContain('**User:** How do I fix it?');
      expect(prompt).toContain('**Agent:** Increase the max pool size to 50 and add connection timeout settings.');
    });

    it('should use default weights when no custom weights are provided', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
      });

      expect(prompt).toContain(`weight: ${DEFAULT_SCORING_WEIGHTS.rootCause}%`);
      expect(prompt).toContain(`weight: ${DEFAULT_SCORING_WEIGHTS.remediation}%`);
      expect(prompt).toContain(`weight: ${DEFAULT_SCORING_WEIGHTS.contextRetention}%`);
      expect(prompt).toContain(`weight: ${DEFAULT_SCORING_WEIGHTS.conciseness}%`);
      // Verify the actual default values appear
      expect(prompt).toContain('weight: 40%');
      expect(prompt).toContain('weight: 30%');
      expect(prompt).toContain('weight: 20%');
      expect(prompt).toContain('weight: 10%');
    });

    it('should use custom weights when provided', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
        scoringWeights: {
          rootCause: 50,
          remediation: 25,
          contextRetention: 15,
          conciseness: 10,
        },
      });

      expect(prompt).toContain('weight: 50%');
      expect(prompt).toContain('weight: 25%');
      expect(prompt).toContain('weight: 15%');
      // conciseness stays at 10 (same as default)
      expect(prompt).toContain('weight: 10%');
    });

    it('should merge partial custom weights with defaults', () => {
      const prompt = buildMultiTurnJudgeSystemPrompt({
        turns: baseTurns,
        idealAnswer: 'Some ideal answer',
        scoringWeights: {
          rootCause: 60,
        },
      });

      // rootCause overridden
      expect(prompt).toContain('weight: 60%');
      // Others remain default
      expect(prompt).toContain('weight: 30%');
      expect(prompt).toContain('weight: 20%');
      expect(prompt).toContain('weight: 10%');
    });
  });

  describe('computeWeightedScore', () => {
    it('should compute correctly with default weights: (80*40 + 70*30 + 90*20 + 85*10) / 100 = 80.5', () => {
      const result = computeWeightedScore({
        rootCauseScore: 80,
        remediationScore: 70,
        contextRetentionScore: 90,
        concisenessScore: 85,
      });

      // (80*40 + 70*30 + 90*20 + 85*10) / 100
      // = (3200 + 2100 + 1800 + 850) / 100
      // = 7950 / 100
      // = 79.5
      expect(result).toBe(79.5);
    });

    it('should compute correctly with custom weights', () => {
      const result = computeWeightedScore(
        {
          rootCauseScore: 80,
          remediationScore: 70,
          contextRetentionScore: 90,
          concisenessScore: 85,
        },
        {
          rootCause: 25,
          remediation: 25,
          contextRetention: 25,
          conciseness: 25,
        }
      );

      // (80*25 + 70*25 + 90*25 + 85*25) / 100
      // = (2000 + 1750 + 2250 + 2125) / 100
      // = 8125 / 100
      // = 81.25
      expect(result).toBe(81.25);
    });

    it('should return 0 when all scores are 0', () => {
      const result = computeWeightedScore({
        rootCauseScore: 0,
        remediationScore: 0,
        contextRetentionScore: 0,
        concisenessScore: 0,
      });

      expect(result).toBe(0);
    });

    it('should return 100 when all scores are 100', () => {
      const result = computeWeightedScore({
        rootCauseScore: 100,
        remediationScore: 100,
        contextRetentionScore: 100,
        concisenessScore: 100,
      });

      // (100*40 + 100*30 + 100*20 + 100*10) / 100 = 10000 / 100 = 100
      expect(result).toBe(100);
    });
  });
});
