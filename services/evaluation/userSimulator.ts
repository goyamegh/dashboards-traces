/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * User Simulator Service
 * Uses an LLM to simulate an on-call SRE generating follow-up questions
 * based on the agent's actual responses and reference turn guidance.
 */

import type { MultiTurnScenario } from '@/types';
import type { AgentMessage } from '@/services/agent/payloadBuilder';
import { ENV_CONFIG } from '@/lib/config';
import { debug } from '@/lib/debug';

export interface SimulatorResponse {
  message: string;
  done: boolean;
}

/**
 * Build the simulator prompt for generating the next follow-up question.
 */
export function buildSimulatorPrompt(
  scenario: MultiTurnScenario,
  conversationHistory: AgentMessage[],
  currentTurnIndex: number
): string {
  const referenceTurn = scenario.referenceTurns?.[currentTurnIndex];

  const conversationText = conversationHistory
    .map(msg => `${msg.role === 'user' ? 'User' : 'Agent'}: ${msg.content}`)
    .join('\n\n');

  let suggestedSection = '';
  if (referenceTurn) {
    suggestedSection = `## Suggested Next Question
"${referenceTurn.user}"
Topics to drive toward: ${referenceTurn.expectedTopics.join(', ')}`;
  } else {
    suggestedSection = `## Suggested Next Question
No reference question available for this turn. Generate your own based on the investigation's natural progression.`;
  }

  return `You are simulating an on-call SRE investigating an incident.

## Your Motivation
${scenario.userMotivation}

## Acceptance Criteria (stop when ALL are met)
${scenario.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${suggestedSection}

## Conversation So Far
${conversationText}

## Instructions
Based on the agent's latest response, either:
1. Generate your next question — use the suggested question as guidance but adapt it
   to make sense given what the agent actually said
2. If ALL acceptance criteria are met, respond with {"done": true, "message": "..."}

Rules:
- If the agent's response aligns with expectations, ask the suggested question naturally
- If the agent diverged, adapt your question to acknowledge what was said while
  steering back toward the expected topics
- Be concise — one question at a time
- Do NOT reveal the ideal answer, acceptance criteria, or ground truth to the agent
- If no suggested question is available (past the reference turns), generate your own
  based on the investigation's natural progression

Respond as JSON: { "done": boolean, "message": "your next question or closing remark" }`;
}

/**
 * Parse the LLM simulator response into a structured SimulatorResponse.
 * Handles both clean JSON and JSON embedded in markdown/text.
 */
export function parseSimulatorResponse(responseText: string): SimulatorResponse {
  const trimmed = responseText.trim();

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    return {
      done: !!parsed.done,
      message: String(parsed.message || ''),
    };
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          done: !!parsed.done,
          message: String(parsed.message || ''),
        };
      } catch {
        // Fall through
      }
    }

    // Try finding JSON object in text
    const startIdx = trimmed.indexOf('{');
    const endIdx = trimmed.lastIndexOf('}');
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        const parsed = JSON.parse(trimmed.slice(startIdx, endIdx + 1));
        return {
          done: !!parsed.done,
          message: String(parsed.message || ''),
        };
      } catch {
        // Fall through
      }
    }

    // Could not parse JSON — treat entire text as the message
    return {
      done: false,
      message: trimmed,
    };
  }
}

/**
 * Generate the next user follow-up question based on conversation history.
 * Calls the backend simulator endpoint, with fallback to reference turns.
 *
 * @param scenario - The multi-turn scenario definition
 * @param conversationHistory - Messages so far (user + assistant)
 * @param currentTurnIndex - 0-based index of the current turn (used for reference turn lookup)
 * @param modelId - Optional model ID for the simulator LLM
 */
export async function generateFollowUp(
  scenario: MultiTurnScenario,
  conversationHistory: AgentMessage[],
  currentTurnIndex: number,
  modelId?: string
): Promise<SimulatorResponse> {
  const simulatorUrl = ENV_CONFIG.simulatorApiUrl || 'http://localhost:4001/api/simulate-followup';

  try {
    debug('UserSimulator', `Generating follow-up for turn ${currentTurnIndex + 1}`);

    const response = await fetch(simulatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario,
        conversationHistory,
        currentTurnIndex,
        modelId,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Simulator API returned ${response.status}`);
    }

    const result = await response.json();
    debug('UserSimulator', `Follow-up generated: done=${result.done}`);
    return result;
  } catch (error) {
    // Fallback: use reference turn verbatim if available
    const referenceTurn = scenario.referenceTurns?.[currentTurnIndex];
    if (referenceTurn) {
      debug('UserSimulator', `LLM failed, falling back to reference turn ${currentTurnIndex + 1}`);
      console.warn(
        '[UserSimulator] LLM simulator failed, using reference turn verbatim:',
        error instanceof Error ? error.message : error
      );
      return {
        done: false,
        message: referenceTurn.user,
      };
    }

    // No fallback available — stop the conversation
    debug('UserSimulator', 'LLM failed and no reference turn available, stopping');
    console.error(
      '[UserSimulator] LLM simulator failed with no fallback:',
      error instanceof Error ? error.message : error
    );
    return {
      done: true,
      message: 'Unable to generate follow-up question.',
    };
  }
}
