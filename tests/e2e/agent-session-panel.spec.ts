/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Run-detail "Agent session" panel — a run is auditable only if the UI shows
 * what the agent HAD ACCESS TO (skills / tools / plugins / MCP servers /
 * model / permission mode / version), what it USED, and what it was DENIED.
 * We seed the exact report shape the Claude Code connector persists
 * (`report.agentSession`, see types/index.ts AgentSessionInfo) and assert
 * the rendered panel. A report WITHOUT agentSession must not render it.
 */
test.describe('Run details — Agent session panel', () => {
  const stamp = Date.now();
  const withSessionId = `e2e-agent-session-${stamp}`;
  const withoutSessionId = `e2e-agent-session-none-${stamp}`;
  const base = {
    timestamp: new Date().toISOString(),
    agentKey: 'subprocess-agent',
    agentName: 'Subprocess Agent',
    modelId: 'claude-sonnet',
    modelName: 'claude-sonnet',
    testCaseId: `e2e-agent-session-tc-${stamp}`,
    status: 'completed',
    passFailStatus: 'passed',
    connectorProtocol: 'claude-code',
    sessionId: 'sess-e2e',
    trajectory: [{ type: 'response', content: 'done', timestamp: Date.now() }],
    llmJudgeReasoning: 'ok',
    metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
  };

  test.beforeAll(async ({ request }) => {
    const a = await request.post('/api/storage/runs', {
      data: {
        ...base,
        id: withSessionId,
        agentSession: {
          agentVersion: '2.1.201',
          model: 'claude-sonnet-4-5',
          permissionMode: 'default',
          cwd: '/repo',
          tools: ['Read', 'Grep', 'Skill', 'ToolSearch'],
          toolsUsed: ['Skill', 'ToolSearch', 'Read', 'WebFetch'],
          skills: ['opensearch-dsl', 'deep-research', 'unused-skill'],
          skillsInvoked: ['opensearch-dsl'],
          plugins: [{ name: 'plugin-a', source: 'user' }],
          mcpServers: [{ name: 'search', status: 'connected' }, { name: 'broken', status: 'failed' }],
          numTurns: 4,
          totalCostUsd: 0.0421,
          durationApiMs: 3210,
          usage: { inputTokens: 1200, outputTokens: 250, cacheCreationInputTokens: 300, cacheReadInputTokens: 4000 },
          permissionDenials: [
            { tool_name: 'Bash', tool_use_id: 't-denied', tool_input: { command: 'cat /etc/passwd' } },
            { tool_name: 'Write', tool_use_id: 't-denied-2', tool_input: { file_path: '/etc/hosts' } },
          ],
          toolErrors: [{ toolName: 'ToolSearch', count: 1 }],
          isError: false,
          stopReason: 'end_turn',
        },
      },
    });
    expect(a.ok()).toBe(true);
    const b = await request.post('/api/storage/runs', { data: { ...base, id: withoutSessionId } });
    expect(b.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/runs/${encodeURIComponent(withSessionId)}`).catch(() => {});
    await request.delete(`/api/storage/runs/${encodeURIComponent(withoutSessionId)}`).catch(() => {});
  });

  test('renders the panel with skills, used/unlisted tools, denials badge, plugins, MCP and cost', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/runs/${withSessionId}`);
    const panel = page.getByTestId('agent-session-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });

    // Collapsed header: headline + summary badges.
    await expect(panel.getByText('v2.1.201 · claude-sonnet-4-5 · default')).toBeVisible();
    await expect(panel.getByText('1/3 skills')).toBeVisible();
    await expect(panel.getByText('4 tools used')).toBeVisible();
    await expect(page.getByTestId('agent-session-denials-badge')).toContainText('2 denied');
    await expect(page.getByTestId('agent-session-unlisted-badge')).toContainText('1 unlisted');
    await expect(page.getByTestId('agent-session-body')).toHaveCount(0);

    // Expand.
    await page.getByTestId('agent-session-toggle').click();
    await expect(page.getByTestId('agent-session-body')).toBeVisible();

    const skills = page.getByTestId('agent-session-skills');
    await expect(skills).toContainText('opensearch-dsl');
    await expect(skills).toContainText('deep-research');
    await expect(skills).toContainText('unused-skill');

    const denials = page.getByTestId('agent-session-denials');
    await expect(denials).toContainText('Bash');
    await expect(denials).toContainText('Write');

    const used = page.getByTestId('agent-session-tools-used');
    await expect(used).toContainText('WebFetch'); // used but not in the allowed list → highlighted
    await expect(used.locator('span[title="Used but not in the allowed tools list"]')).toHaveText('WebFetch');

    await expect(page.getByTestId('agent-session-tools')).toContainText('ToolSearch');
    await expect(page.getByTestId('agent-session-tool-errors')).toContainText('ToolSearch ×1');
    await expect(page.getByTestId('agent-session-plugins')).toContainText('plugin-a');
    const mcp = page.getByTestId('agent-session-mcp');
    await expect(mcp).toContainText('search · connected');
    await expect(mcp).toContainText('broken · failed');

    const body = page.getByTestId('agent-session-body');
    await expect(body).toContainText('4 turns');
    await expect(body).toContainText('$0.04');
    await expect(body).toContainText('5.8K tokens');
    await expect(body).toContainText('3.2s API');

    await panel.screenshot({ path: '.pi/web/artifacts/agent-session-panel.png' });
  });

  test('does not render the panel for a report without agentSession', async ({ page }) => {
    await page.goto(`/runs/${withoutSessionId}`);
    await expect(page.locator('text=Test Case Output').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('agent-session-panel')).toHaveCount(0);
  });
});
