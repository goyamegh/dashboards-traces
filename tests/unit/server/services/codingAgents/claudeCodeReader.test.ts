/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type ClaudeCodeModule = typeof import('@/server/services/codingAgents/readers/claudeCode');

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function jsonl(lines: Array<Record<string, unknown> | string>): string {
  return `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`;
}

function loadClaudeCodeModule(homeDir: string): ClaudeCodeModule {
  jest.resetModules();
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => homeDir,
  }));
  return require('@/server/services/codingAgents/readers/claudeCode') as ClaudeCodeModule;
}

describe('ClaudeCodeReader', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-reader-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('parses session metadata, resolves project paths, and sorts sessions by start time', async () => {
    const projectOne = path.join(homeDir, '.claude', 'projects', 'workspace-one');
    const projectTwo = path.join(homeDir, '.claude', 'projects', 'team-project-alpha');

    writeFixture(path.join(projectOne, 'older-session.jsonl'), jsonl([
      '{not-json',
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: '/workspaces/app-one',
      },
      {
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'user',
        message: {
          content: '<system>ignored</system>Hello from Claude',
        },
      },
      {
        timestamp: '2024-01-01T00:00:02.000Z',
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'mcp__repo__search', input: { query: 'foo' } },
            { type: 'text', text: 'Searching the repository' },
          ],
        },
      },
      {
        timestamp: '2024-01-01T00:00:03.000Z',
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'permission denied', is_error: true },
            { type: 'text', text: 'Please continue' },
          ],
        },
      },
      {
        timestamp: '2024-01-01T00:00:04.000Z',
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    ]));

    writeFixture(path.join(projectTwo, 'newer-session.jsonl'), jsonl([
      {
        timestamp: '2024-01-02T00:00:00.000Z',
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'Second prompt' }],
        },
      },
      {
        timestamp: '2024-01-02T00:00:01.000Z',
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-2', name: 'bash', input: { command: 'pwd' } }],
        },
      },
    ]));

    const { ClaudeCodeReader } = loadClaudeCodeModule(homeDir);
    const reader = new ClaudeCodeReader();

    await expect(reader.isAvailable()).resolves.toBe(true);

    const sessions = await reader.getSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(session => session.session_id)).toEqual(['newer-session', 'older-session']);

    const older = sessions.find(session => session.session_id === 'older-session');
    expect(older).toMatchObject({
      agent: 'claude-code',
      project_path: '/workspaces/app-one',
      user_message_count: 2,
      assistant_message_count: 2,
      session_completed: true,
      first_prompt: 'Hello from Claude',
      uses_mcp: true,
      model: 'claude-haiku-4-5',
    });
    expect(older?.tool_counts).toEqual({ mcp__repo__search: 1 });
    expect(older?.tool_error_counts).toEqual({ mcp__repo__search: 1 });
    expect(older?.estimated_cost).toBeGreaterThan(0);
    expect(older?.duration_minutes).toBeCloseTo(4 / 60, 5);

    const newer = sessions.find(session => session.session_id === 'newer-session');
    expect(newer).toMatchObject({
      project_path: 'team/project/alpha',
      user_message_count: 1,
      assistant_message_count: 1,
      session_completed: false,
      first_prompt: 'Second prompt',
      uses_mcp: false,
    });
    expect(newer?.tool_counts).toEqual({ bash: 1 });
  });

  it('builds session detail, rereads sessions, and computes aggregate stats', async () => {
    const projectDir = path.join(homeDir, '.claude', 'projects', 'workspace-one');
    const filePath = path.join(projectDir, 'detail-session.jsonl');
    writeFixture(filePath, jsonl([
      {
        timestamp: '2024-03-01T00:00:00.000Z',
        cwd: '/repo/detail-project',
      },
      {
        timestamp: '2024-03-01T00:00:01.000Z',
        type: 'user',
        message: {
          content: 'Review the current plan',
        },
      },
      {
        timestamp: '2024-03-01T00:00:02.000Z',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 2,
          },
          content: [
            { type: 'tool_use', id: 'tool-9', name: 'bash', input: { command: 'ls' } },
            { type: 'text', text: 'Listing the repo' },
          ],
        },
      },
      {
        timestamp: '2024-03-01T00:00:03.000Z',
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-9', content: ['README.md', 'src'], is_error: false },
            { type: 'text', text: '<internal>strip</internal>Continue' },
          ],
        },
      },
      {
        timestamp: '2024-03-01T00:00:04.000Z',
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Completed.' }],
        },
      },
    ]));

    const { ClaudeCodeReader } = loadClaudeCodeModule(homeDir);
    const reader = new ClaudeCodeReader();

    const reread = await reader.rereadSession(filePath);
    expect(reread?.project_path).toBe('/repo/detail-project');
    expect(reread?.session_completed).toBe(true);

    const detail = await reader.getSessionDetail('detail-session');
    expect(detail).not.toBeNull();
    expect(detail?.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'tool_result',
      'user',
      'assistant',
    ]);
    expect(detail?.messages[1]).toMatchObject({
      role: 'assistant',
      toolName: 'bash',
    });
    expect(detail?.messages[3]).toMatchObject({
      role: 'tool_result',
      text: '["README.md","src"]',
      toolName: 'tool-9',
      isError: false,
    });
    expect(detail?.messages[4].text).toBe('Continue');

    await expect(reader.getSessionDetail('missing-session')).resolves.toBeNull();

    const stats = await reader.getStats();
    expect(stats).toMatchObject({
      agent: 'claude-code',
      totalSessions: 1,
      totalToolCalls: 1,
      totalToolErrors: 0,
      completedSessions: 1,
      activeDays: 1,
    });
    expect(stats.totalInputTokens).toBe(10);
    expect(stats.totalOutputTokens).toBe(5);
    expect(stats.totalCacheSavings).toBeGreaterThan(0);
    expect(stats.avgSessionMinutes).toBeCloseTo(4 / 60, 5);
    expect(stats.dailyActivity).toEqual([
      {
        date: '2024-03-01',
        messageCount: 4,
        sessionCount: 1,
        toolCallCount: 1,
      },
    ]);
  });

  it('returns empty or null when project data is unavailable or unusable', async () => {
    const projectDir = path.join(homeDir, '.claude', 'projects', 'broken-project');
    writeFixture(path.join(projectDir, 'no-timestamp.jsonl'), jsonl([
      {
        type: 'user',
        message: {
          content: 'No timestamp here',
        },
      },
    ]));

    const { ClaudeCodeReader } = loadClaudeCodeModule(homeDir);
    const reader = new ClaudeCodeReader();

    expect(await reader.getSessions()).toEqual([]);
    await expect(reader.getSessionDetail('no-timestamp')).resolves.toBeNull();
  });

  it('reports unavailable when the Claude projects directory does not exist', async () => {
    const { ClaudeCodeReader } = loadClaudeCodeModule(homeDir);
    const reader = new ClaudeCodeReader();

    await expect(reader.isAvailable()).resolves.toBe(false);
    await expect(reader.getSessions()).resolves.toEqual([]);
  });
});
