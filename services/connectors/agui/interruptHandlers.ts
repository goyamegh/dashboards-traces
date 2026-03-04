/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interrupt Handlers for AG-UI Streaming Connector
 * Detects and responds to tool approval / human input interrupts
 * so multi-turn evaluation can continue transparently.
 */

import type { AgentMessage } from '@/services/agent/payloadBuilder';

// ============ Types ============

/** Policy for handling tool-approval interrupts within a single turn */
export type InterruptPolicy = 'auto-approve' | 'auto-reject' | 'skip';

/** Parsed interrupt information from RunFinishedEvent.result */
export interface InterruptInfo {
  reason: string;
  toolCalls?: Array<{ id: string; name: string; args?: any }>;
  rawResult: any;
}

/** Multi-turn options controlling interrupt handling inside the connector */
export interface MultiTurnOptions {
  enabled: boolean;
  maxTurns: number;
  interruptPolicy: InterruptPolicy;
  detectInterrupt?: (result: any) => InterruptInfo | null;
  buildResponse?: (interrupt: InterruptInfo, policy: InterruptPolicy) => AgentMessage | null;
}

// ============ Defaults ============

export const DEFAULT_MULTI_TURN_OPTIONS: MultiTurnOptions = {
  enabled: false,
  maxTurns: 10,
  interruptPolicy: 'auto-approve',
};

// ============ Detection ============

/**
 * Default interrupt detector.
 * Checks for common interrupt patterns:
 *  - Pulsar-style: { outcome: "interrupt", ... }
 *  - Generic: { type: "tool_approval" | "human_input_required", ... }
 *  - Explicit: { requiresApproval: true, ... }
 */
export function defaultDetectInterrupt(result: any): InterruptInfo | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  // Pulsar-style interrupt
  if (result.outcome === 'interrupt') {
    return {
      reason: result.reason || 'Tool approval required',
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : undefined,
      rawResult: result,
    };
  }

  // Generic interrupt types
  if (result.type === 'tool_approval' || result.type === 'human_input_required') {
    return {
      reason: result.message || result.reason || result.type,
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : undefined,
      rawResult: result,
    };
  }

  // Explicit approval flag
  if (result.requiresApproval === true) {
    return {
      reason: result.reason || 'Approval required',
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : undefined,
      rawResult: result,
    };
  }

  return null;
}

// ============ Response Building ============

/**
 * Build an approval/rejection response message for an interrupt.
 * Returns null if the policy is 'skip' (don't respond, stop the loop).
 */
export function defaultBuildApprovalResponse(
  interrupt: InterruptInfo,
  policy: InterruptPolicy
): AgentMessage | null {
  if (policy === 'skip') {
    return null;
  }

  const approved = policy === 'auto-approve';
  const content = approved
    ? 'Approved. Please proceed with the tool calls.'
    : 'Rejected. Do not execute the proposed tool calls.';

  return {
    id: `interrupt-resp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    role: 'user',
    content,
  };
}

// ============ Options Resolution ============

/**
 * Merge partial multi-turn options with defaults.
 */
export function resolveMultiTurnOptions(
  partial?: Partial<MultiTurnOptions>
): MultiTurnOptions {
  if (!partial) {
    return { ...DEFAULT_MULTI_TURN_OPTIONS };
  }
  return {
    ...DEFAULT_MULTI_TURN_OPTIONS,
    ...partial,
  };
}
