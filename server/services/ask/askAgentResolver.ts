/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve WHICH agent answers a "highlight & ask" question.
 *
 * Standard configuration only: `assistant.agentKey` in `agent-health.config.ts`
 * names an entry of the existing `agents[]` registry. The agent's connector
 * must be able to run a free-form chat turn — today that is the three
 * subprocess connectors (`claude-code`, `kiro`, `pi`). HTTP agents (`rest`,
 * `agui-streaming`, …) are task-shaped (they expect a test-case prompt and
 * return a trajectory) and are rejected with a clear error instead of a
 * confusing answer.
 *
 * When nothing is configured, the built-in pi-SDK assistant is used: pi's
 * agent loop in-process with read-only tools over this server's own API (the
 * same pattern as the agent trace judge).
 */

import type { AgentConfig } from '@/types';
import type { ConnectorProtocol } from '@/services/connectors/types';

/** Key of the built-in assistant (not an `agents[]` entry). */
export const ASK_BUILTIN_AGENT_KEY = 'builtin-pi';
export const ASK_BUILTIN_AGENT_NAME = 'Agent Health assistant (pi SDK, read-only tools)';

/** Connector protocols that can run a free-form chat turn. */
export const ASK_SUPPORTED_CONNECTORS: readonly ConnectorProtocol[] = ['claude-code', 'kiro', 'pi'];

export type AskAgentChoice =
  | { kind: 'builtin'; key: typeof ASK_BUILTIN_AGENT_KEY; name: string; connectorType: 'pi-sdk' }
  | { kind: 'connector'; key: string; name: string; connectorType: ConnectorProtocol; agent: AgentConfig };

export interface AskAgentResolverConfig {
  agents: AgentConfig[];
  assistant?: { agentKey?: string };
}

export class AskAgentResolutionError extends Error {
  constructor(message: string, readonly code: 'not-found' | 'unsupported-connector') {
    super(message);
    this.name = 'AskAgentResolutionError';
  }
}

export function isAskCapableConnector(connectorType: string | undefined): boolean {
  return ASK_SUPPORTED_CONNECTORS.includes((connectorType ?? 'agui-streaming') as ConnectorProtocol);
}

function builtinChoice(): AskAgentChoice {
  return { kind: 'builtin', key: ASK_BUILTIN_AGENT_KEY, name: ASK_BUILTIN_AGENT_NAME, connectorType: 'pi-sdk' };
}

function toChoice(agent: AgentConfig): AskAgentChoice {
  return {
    kind: 'connector',
    key: agent.key,
    name: agent.name,
    connectorType: (agent.connectorType ?? 'agui-streaming') as ConnectorProtocol,
    agent,
  };
}

/**
 * Every agent the UI may offer in its picker: the built-in assistant first,
 * then each configured agent whose connector can chat. The configured
 * default (if any) is flagged so the picker can preselect it.
 */
export function listAskAgents(config: AskAgentResolverConfig): Array<AskAgentChoice & { isDefault: boolean }> {
  const defaultKey = config.assistant?.agentKey ?? ASK_BUILTIN_AGENT_KEY;
  const choices: AskAgentChoice[] = [
    builtinChoice(),
    ...config.agents.filter((a) => isAskCapableConnector(a.connectorType)).map(toChoice),
  ];
  return choices.map((c) => ({ ...c, isDefault: c.key === defaultKey }));
}

/**
 * Resolve the agent for one question. Precedence: the request's explicit
 * `agentKey` > `assistant.agentKey` from config > built-in.
 *
 * @throws AskAgentResolutionError when the key names no agent, or an agent
 *   whose connector cannot run a chat turn.
 */
export function resolveAskAgent(config: AskAgentResolverConfig, requestedKey?: string): AskAgentChoice {
  const key = (requestedKey ?? config.assistant?.agentKey ?? ASK_BUILTIN_AGENT_KEY).trim();
  if (!key || key === ASK_BUILTIN_AGENT_KEY) return builtinChoice();

  const agent = config.agents.find((a) => a.key === key);
  if (!agent) {
    const capable = config.agents.filter((a) => isAskCapableConnector(a.connectorType)).map((a) => a.key);
    throw new AskAgentResolutionError(
      `Assistant agent "${key}" is not in agents[] of agent-health.config.ts. ` +
        `Chat-capable agents: ${capable.length ? capable.join(', ') : '(none)'}; or use "${ASK_BUILTIN_AGENT_KEY}".`,
      'not-found'
    );
  }
  if (!isAskCapableConnector(agent.connectorType)) {
    throw new AskAgentResolutionError(
      `Assistant agent "${key}" uses connector "${agent.connectorType ?? 'agui-streaming'}", which cannot run a chat turn. ` +
        `Supported connectors: ${ASK_SUPPORTED_CONNECTORS.join(', ')}.`,
      'unsupported-connector'
    );
  }
  return toChoice(agent);
}
