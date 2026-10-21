/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ASK_BUILTIN_AGENT_KEY,
  AskAgentResolutionError,
  listAskAgents,
  resolveAskAgent,
} from '@/server/services/ask/askAgentResolver';
import type { AgentConfig } from '@/types';

const agents = [
  { key: 'cc', name: 'Claude Code', endpoint: 'claude', connectorType: 'claude-code' },
  { key: 'kiro', name: 'Kiro', endpoint: 'kiro-cli', connectorType: 'kiro' },
  { key: 'pi', name: 'pi', endpoint: 'pi', connectorType: 'pi' },
  { key: 'search', name: 'REST search agent', endpoint: 'http://localhost:9999', connectorType: 'rest' },
  { key: 'legacy', name: 'No connectorType (defaults to agui-streaming)', endpoint: 'http://localhost:9998' },
] as unknown as AgentConfig[];

describe('resolveAskAgent (assistant.agentKey from agent-health.config.ts)', () => {
  it('defaults to the built-in pi-SDK assistant when nothing is configured', () => {
    const r = resolveAskAgent({ agents });
    expect(r.kind).toBe('builtin');
    expect(r.key).toBe(ASK_BUILTIN_AGENT_KEY);
  });

  it('uses assistant.agentKey from config', () => {
    const r = resolveAskAgent({ agents, assistant: { agentKey: 'cc' } });
    expect(r.kind).toBe('connector');
    expect(r.key).toBe('cc');
    expect(r.connectorType).toBe('claude-code');
  });

  it.each(['cc', 'kiro', 'pi'])('accepts every chat-capable connector (%s)', (key) => {
    expect(resolveAskAgent({ agents }, key).kind).toBe('connector');
  });

  it('request agentKey overrides the configured default', () => {
    const r = resolveAskAgent({ agents, assistant: { agentKey: 'cc' } }, 'pi');
    expect(r.key).toBe('pi');
  });

  it('"builtin-pi" always resolves to the builtin even when a default is configured', () => {
    const r = resolveAskAgent({ agents, assistant: { agentKey: 'cc' } }, ASK_BUILTIN_AGENT_KEY);
    expect(r.kind).toBe('builtin');
  });

  it('a missing key fails with a clear error that lists the chat-capable agents', () => {
    let err: unknown;
    try { resolveAskAgent({ agents, assistant: { agentKey: 'nope' } }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AskAgentResolutionError);
    expect((err as AskAgentResolutionError).code).toBe('not-found');
    expect((err as Error).message).toMatch(/"nope" is not in agents\[\]/);
    expect((err as Error).message).toMatch(/cc, kiro, pi/);
    expect((err as Error).message).not.toMatch(/search/); // REST agents are not offered
  });

  it('an HTTP/REST agent is rejected with the connector named', () => {
    let err: unknown;
    try { resolveAskAgent({ agents }, 'search'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AskAgentResolutionError);
    expect((err as AskAgentResolutionError).code).toBe('unsupported-connector');
    expect((err as Error).message).toMatch(/connector "rest", which cannot run a chat turn/);
    expect((err as Error).message).toMatch(/claude-code, kiro, pi/);
  });

  it('an agent without connectorType is treated as agui-streaming and rejected', () => {
    expect(() => resolveAskAgent({ agents }, 'legacy')).toThrow(/connector "agui-streaming"/);
  });
});

describe('listAskAgents', () => {
  it('offers the builtin first, then only chat-capable agents, flagging the configured default', () => {
    const list = listAskAgents({ agents, assistant: { agentKey: 'kiro' } });
    expect(list.map((a) => a.key)).toEqual([ASK_BUILTIN_AGENT_KEY, 'cc', 'kiro', 'pi']);
    expect(list.find((a) => a.isDefault)?.key).toBe('kiro');
  });

  it('flags the builtin as default when nothing is configured', () => {
    expect(listAskAgents({ agents }).find((a) => a.isDefault)?.key).toBe(ASK_BUILTIN_AGENT_KEY);
  });
});
