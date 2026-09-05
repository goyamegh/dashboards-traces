/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for the run-detail "Agent session" panel — what the agent
 * HAD ACCESS TO / USED / WAS DENIED, from `report.agentSession`.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSessionPanel } from '@/components/AgentSessionPanel';
import type { AgentSessionInfo } from '@/types';

const full: AgentSessionInfo = {
  agentVersion: '2.1.201',
  model: 'claude-sonnet-4-5',
  permissionMode: 'default',
  cwd: '/repo',
  tools: ['Read', 'Grep', 'Skill'],
  toolsUsed: ['Skill', 'Read', 'WebFetch'],
  skills: ['opensearch-dsl', 'deep-research'],
  skillsInvoked: ['opensearch-dsl', 'not-offered'],
  plugins: [{ name: 'plugin-a', source: 'user' }],
  mcpServers: [{ name: 'search', status: 'connected' }, { name: 'broken', status: 'failed' }],
  agents: ['Explore'],
  memoryPaths: ['/repo/CLAUDE.md', '/' + 'x'.repeat(80)],
  numTurns: 4,
  totalCostUsd: 0.0421,
  durationApiMs: 3210,
  usage: { inputTokens: 1200, outputTokens: 250, cacheCreationInputTokens: 300, cacheReadInputTokens: 4000 },
  permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'rm' } }, { toolName: 'Write' }, { other: 1 }],
  toolErrors: [{ toolName: 'ToolSearch', count: 2, firstError: 'No matching deferred tools found' }],
  isError: true,
  stopReason: 'error_max_turns',
};

describe('AgentSessionPanel', () => {
  it('renders nothing without session info', () => {
    const { container } = render(React.createElement(AgentSessionPanel, { session: undefined }));
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(React.createElement(AgentSessionPanel, { session: {} }));
    expect(c2.firstChild).toBeNull();
  });

  it('collapsed header shows headline + summary badges; body appears on toggle', () => {
    render(React.createElement(AgentSessionPanel, { session: full }));
    expect(screen.getByText('v2.1.201 · claude-sonnet-4-5 · default')).toBeTruthy();
    expect(screen.getByText('1/2 skills')).toBeTruthy();
    expect(screen.getByText('3 tools used')).toBeTruthy();
    expect(screen.getByTestId('agent-session-denials-badge').textContent).toContain('3 denied');
    expect(screen.getByTestId('agent-session-unlisted-badge').textContent).toContain('1 unlisted');
    expect(screen.queryByTestId('agent-session-body')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-session-toggle'));
    const body = screen.getByTestId('agent-session-body');
    expect(body).toBeTruthy();

    // Run row: turns / cost / total tokens / API time / error-toned stop reason
    expect(body.textContent).toContain('4 turns');
    expect(body.textContent).toContain('$0.04');
    expect(body.textContent).toContain('5.8K tokens');
    expect(body.textContent).toContain('3.2s API');
    expect(body.textContent).toContain('error_max_turns');

    // Denials: tool_name, toolName, and unknown shapes
    const denials = screen.getByTestId('agent-session-denials');
    expect(denials.textContent).toContain('Bash');
    expect(denials.textContent).toContain('Write');
    expect(denials.textContent).toContain('unknown tool');

    expect(screen.getByTestId('agent-session-tool-errors').textContent).toContain('ToolSearch ×2');
    expect(screen.getByTestId('agent-session-tool-errors').querySelector('[title]')?.getAttribute('title')).toBe('First error: No matching deferred tools found');

    // Used-but-unlisted tool is flagged
    const used = screen.getByTestId('agent-session-tools-used');
    expect(used.querySelector('[title="Used but not in the allowed tools list"]')?.textContent).toBe('WebFetch');
    expect(screen.getByTestId('agent-session-tools').textContent).toContain('Grep');

    // Skills: invoked vs available vs invoked-but-not-offered
    const skills = screen.getByTestId('agent-session-skills');
    expect(skills.querySelector('[title="Invoked in this run"]')?.textContent).toBe('opensearch-dsl');
    expect(skills.querySelector('[title="Available, not invoked"]')?.textContent).toBe('deep-research');
    expect(skills.querySelector('[title="Invoked but not in the available skills list"]')?.textContent).toBe('not-offered');

    expect(screen.getByTestId('agent-session-plugins').textContent).toContain('plugin-a');
    const mcp = screen.getByTestId('agent-session-mcp');
    expect(mcp.textContent).toContain('search · connected');
    expect(mcp.textContent).toContain('broken · failed');
    expect(body.textContent).toContain('Explore');
    expect(body.textContent).toContain('/repo/CLAUDE.md');
    // Long memory path is tail-truncated with an ellipsis
    expect(body.textContent).toContain('…' + 'x'.repeat(58));
    expect(body.textContent).toContain('/repo');

    // Collapses again
    fireEvent.click(screen.getByTestId('agent-session-toggle'));
    expect(screen.queryByTestId('agent-session-body')).toBeNull();
  });

  it('handles a sparse session: no allowed list means no "unlisted" flag, no denials badge, "none" for zero tools used', () => {
    render(React.createElement(AgentSessionPanel, { session: { model: 'm', tools: ['Read'], numTurns: 1 }, defaultOpen: true }));
    expect(screen.queryByTestId('agent-session-denials-badge')).toBeNull();
    expect(screen.queryByTestId('agent-session-unlisted-badge')).toBeNull();
    expect(screen.getByTestId('agent-session-tools-used').textContent).toContain('none');
    expect(screen.queryByTestId('agent-session-skills')).toBeNull();
  });

  it('does not flag used tools as unlisted when the allowed list is unknown', () => {
    render(React.createElement(AgentSessionPanel, { session: { toolsUsed: ['Anything'] }, defaultOpen: true }));
    expect(screen.queryByTestId('agent-session-unlisted-badge')).toBeNull();
    expect(screen.getByTestId('agent-session-tools-used').querySelector('[title]')).toBeNull();
  });
});
