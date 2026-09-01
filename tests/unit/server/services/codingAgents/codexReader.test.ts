/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type CodexModule = typeof import('@/server/services/codingAgents/readers/codex');

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function jsonl(lines: Array<Record<string, unknown> | string>): string {
  return `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`;
}

function loadCodexModule(homeDir: string): CodexModule {
  jest.resetModules();
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => homeDir,
  }));
  return require('@/server/services/codingAgents/readers/codex') as CodexModule;
}

describe('CodexReader', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reader-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('finds rollout files recursively and parses sessions with tool failures', async () => {
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');

    writeFixture(path.join(sessionsRoot, 'daily', 'rollout-first.jsonl'), jsonl([
      {
        timestamp: '2024-05-01T00:00:00.000Z',
        item: {
          type: 'SessionMeta',
          working_directory: '/workspace/alpha',
          model: 'o3',
        },
      },
      {
        timestamp: '2024-05-01T00:00:01.000Z',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Investigate the failing command' }],
        },
      },
      {
        timestamp: '2024-05-01T00:00:02.000Z',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking the logs now' }],
        },
      },
      {
        timestamp: '2024-05-01T00:00:03.000Z',
        item: {
          type: 'function_call',
          name: 'shell',
          arguments: { command: 'ls' },
        },
      },
      {
        timestamp: '2024-05-01T00:00:04.000Z',
        item: {
          type: 'function_call_output',
          output: 'ENOENT: command failed',
        },
      },
      {
        timestamp: '2024-05-01T00:00:05.000Z',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The command failed because the file is missing.' }],
        },
      },
    ]));

    writeFixture(path.join(sessionsRoot, 'nested', 'rollout-second.jsonl'), jsonl([
      '{bad-json',
      {
        timestamp: '2024-05-02T00:00:00.000Z',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Second run' }],
        },
      },
      {
        timestamp: '2024-05-02T00:00:01.000Z',
        item: {
          type: 'function_call',
          tool_name: 'search',
          arguments: { query: 'coverage' },
        },
      },
      {
        timestamp: '2024-05-02T00:00:02.000Z',
        item: {
          type: 'function_call_output',
          output: { status: 'ok' },
        },
      },
    ]));
    writeFixture(path.join(sessionsRoot, 'nested', 'ignored.txt'), 'skip me');

    const { CodexReader } = loadCodexModule(homeDir);
    const reader = new CodexReader();

    await expect(reader.isAvailable()).resolves.toBe(true);

    const sessions = await reader.getSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(session => session.session_id)).toEqual(['second', 'first']);

    const first = sessions.find(session => session.session_id === 'first');
    expect(first).toMatchObject({
      agent: 'codex',
      project_path: '/workspace/alpha',
      first_prompt: 'Investigate the failing command',
      uses_mcp: false,
      model: 'o3',
      session_completed: true,
      total_tool_errors: 1,
    });
    expect(first?.tool_counts).toEqual({ shell: 1 });
    expect(first?.tool_error_counts).toEqual({ shell: 1 });
    expect(first?.duration_minutes).toBeCloseTo(5 / 60, 5);

    const second = sessions.find(session => session.session_id === 'second');
    expect(second).toMatchObject({
      project_path: 'unknown',
      first_prompt: 'Second run',
      model: undefined,
      session_completed: false,
      total_tool_errors: 0,
    });
    expect(second?.tool_counts).toEqual({ search: 1 });
  });

  it('builds session detail and aggregate stats from rollout files', async () => {
    const rolloutPath = path.join(homeDir, '.codex', 'sessions', 'rollout-detail.jsonl');
    writeFixture(rolloutPath, jsonl([
      {
        timestamp: '2024-06-01T00:00:00.000Z',
        item: {
          type: 'SessionMeta',
          working_directory: '/workspace/detail',
          model: 'gpt-4.1',
        },
      },
      {
        timestamp: '2024-06-01T00:00:01.000Z',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Open the failing report' },
            { type: 'input_text', text: 'Summarize the issue' },
          ],
        },
      },
      {
        timestamp: '2024-06-01T00:00:02.000Z',
        item: {
          type: 'function_call',
          name: 'open_file',
          arguments: { path: 'report.log' },
        },
      },
      {
        timestamp: '2024-06-01T00:00:03.000Z',
        item: {
          type: 'function_call_output',
          output: { lines: ['error line 1', 'error line 2'] },
        },
      },
      {
        timestamp: '2024-06-01T00:00:04.000Z',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The report shows a parser error.' }],
        },
      },
    ]));

    const { CodexReader } = loadCodexModule(homeDir);
    const reader = new CodexReader();

    const detail = await reader.getSessionDetail('detail');
    expect(detail).not.toBeNull();
    expect(detail?.session).toMatchObject({
      session_id: 'detail',
      project_path: '/workspace/detail',
      model: 'gpt-4.1',
    });
    expect(detail?.messages).toEqual([
      {
        role: 'user',
        text: 'Open the failing report\nSummarize the issue',
        timestamp: '2024-06-01T00:00:01.000Z',
      },
      {
        role: 'assistant',
        text: 'Tool: open_file\n{\n  "path": "report.log"\n}',
        timestamp: '2024-06-01T00:00:02.000Z',
        toolName: 'open_file',
      },
      {
        role: 'tool_result',
        text: '{"lines":["error line 1","error line 2"]}',
        timestamp: '2024-06-01T00:00:03.000Z',
        toolName: 'open_file',
        isError: true,
      },
      {
        role: 'assistant',
        text: 'The report shows a parser error.',
        timestamp: '2024-06-01T00:00:04.000Z',
      },
    ]);
    await expect(reader.getSessionDetail('missing')).resolves.toBeNull();

    const stats = await reader.getStats();
    expect(stats).toMatchObject({
      agent: 'codex',
      totalSessions: 1,
      totalToolCalls: 1,
      totalToolErrors: 0,
      completedSessions: 1,
      activeDays: 1,
    });
    expect(stats.dailyActivity).toEqual([
      {
        date: '2024-06-01',
        messageCount: 2,
        sessionCount: 1,
        toolCallCount: 1,
      },
    ]);
  });

  it('returns empty results when the Codex session directory is missing', async () => {
    const { CodexReader } = loadCodexModule(homeDir);
    const reader = new CodexReader();

    await expect(reader.isAvailable()).resolves.toBe(false);
    await expect(reader.getSessions()).resolves.toEqual([]);
    await expect(reader.getSessionDetail('absent')).resolves.toBeNull();
  });
});
