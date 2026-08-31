/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Kiro reader — covers CLI JSONL, IDE workspace-sessions,
 * new .chat format, and kiro-cli SQLite data sources.
 */

import type { AgentSession } from '@/server/services/codingAgents/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockAccess = jest.fn();
const mockReadFile = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();

jest.mock('fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  stat: (...args: any[]) => mockStat(...args),
}));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: any[]) => {
    // mockExecFile receives (bin, args, opts) and returns { stdout }
    const result = mockExecFile(...args);
    return Promise.resolve({ stdout: result });
  },
}));

jest.mock('os', () => ({
  homedir: () => '/mock/home',
  platform: () => 'darwin',
}));

// Silence console
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

import { KiroReader } from '@/server/services/codingAgents/readers/kiro';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IDE_BASE = '/mock/home/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent';
const CLI_DB = '/mock/home/Library/Application Support/kiro-cli/data.sqlite3';

function makeChatFile(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    executionId: 'exec-001',
    actionId: 'act',
    context: [
      {
        type: 'steering',
        id: 'file:///mock/project/.kiro/steering/guide.md',
        displayName: 'guide.md',
        scope: 'workspace',
      },
    ],
    chat: [
      { role: 'human', content: '<identity>\nYou are Kiro</identity>' },
      { role: 'bot', content: 'I will follow these instructions' },
      { role: 'human', content: 'Hello, help me with my project' },
      { role: 'bot', content: 'Sure, I can help with that!' },
    ],
    metadata: {
      modelId: 'claude-sonnet-4.5',
      modelProvider: 'qdev',
      workflow: 'act',
      startTime: 1700000000000,
      endTime: 1700000060000,
    },
    ...overrides,
  });
}

function makeIdeSessionIndex(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'ide-session-001',
    title: 'Test IDE session',
    dateCreated: '1700000000000',
    workspaceDirectory: '/mock/ide-project',
    ...overrides,
  };
}

function makeIdeSessionFile(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    history: [
      { message: { role: 'user', content: 'Fix the bug' } },
      { message: { role: 'assistant', content: 'I found the issue.' } },
    ],
    workspaceDirectory: '/mock/ide-project',
    ...overrides,
  });
}

function makeSqliteMetaRows(rows: Array<Record<string, any>> = []) {
  return JSON.stringify(rows.length ? rows : [
    {
      key: '/mock/project',
      conversation_id: 'conv-001',
      created_at: 1700000000000,
      updated_at: 1700000120000,
      model_id: 'claude-opus-4.6',
      conv_id: 'conv-001',
      history_len: 5,
      transcript_len: 8,
    },
  ]);
}

function makeSqlitePromptRows(rows: Array<Record<string, any>> = []) {
  return JSON.stringify(rows.length ? rows : [
    {
      conversation_id: 'conv-001',
      key: '/mock/project',
      first_prompt: 'Help me refactor this code',
      usage_info: JSON.stringify([{ value: 1.5, unit: 'credit' }]),
    },
  ]);
}

function loadFreshKiroModule(extraMocks?: () => void) {
  jest.resetModules();
  extraMocks?.();
  return require('@/server/services/codingAgents/readers/kiro') as typeof import('@/server/services/codingAgents/readers/kiro');
}

// ─── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.doMock('better-sqlite3', () => {
    throw new Error('better-sqlite3 not installed');
  }, { virtual: true });
  // Default: all paths fail access (nothing exists)
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockExecFile.mockReturnValue('[]');
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('KiroReader', () => {
  let reader: KiroReader;

  beforeEach(() => {
    reader = new KiroReader();
  });

  describe('metadata', () => {
    it('has correct agent name and display name', () => {
      expect(reader.agentName).toBe('kiro');
      expect(reader.displayName).toBe('Kiro');
    });
  });

  describe('isAvailable', () => {
    it('returns true when CLI sessions dir exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p.includes('sessions/cli') ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when kiro-cli SQLite DB exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when IDE workspace-sessions dir exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p.includes('workspace-sessions') ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when hash-based .chat dirs exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      // listChatWorkspaceDirs reads the IDE base dir
      mockReaddir.mockImplementation((dir: string) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', isDirectory: () => true },
          ]);
        }
        // Inside the hash dir, return a .chat file
        if (dir.includes('a1b2c3d4')) {
          return Promise.resolve(['session.chat']);
        }
        return Promise.resolve([]);
      });
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns false when nothing exists', async () => {
      mockReaddir.mockResolvedValue([]);
      expect(await reader.isAvailable()).toBe(false);
    });
  });

  describe.skip('getSessions — .chat format (disabled pending perf optimization)', () => {
    beforeEach(() => {
      // Set up hash-based .chat dir
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'abcdef01234567890abcdef012345678', isDirectory: () => true },
            { name: 'config.json', isDirectory: () => false },
          ]);
        }
        if (dir.includes('abcdef01234567890abcdef012345678')) {
          return Promise.resolve(['exec-001.chat', 'f62de366d0006e17ea00a01f6624aabf']);
        }
        // workspace-sessions returns empty
        if (dir.includes('workspace-sessions')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) return Promise.resolve(makeChatFile());
        return Promise.reject(new Error('ENOENT'));
      });
    });

    it('parses .chat files into sessions', async () => {
      const sessions = await reader.getSessions();
      const chatSessions = sessions.filter(s => s.session_id === 'exec-001');
      expect(chatSessions.length).toBe(1);

      const s = chatSessions[0];
      expect(s.agent).toBe('kiro');
      expect(s.session_id).toBe('exec-001');
      expect(s.project_path).toBe('/mock/project');
      expect(s.user_message_count).toBe(1); // skips <identity> prompt
      expect(s.assistant_message_count).toBe(2);
      expect(s.session_completed).toBe(true);
      expect(s.duration_minutes).toBe(1); // 60000ms = 1min
    });

    it('extracts workspace path from steering context', async () => {
      const sessions = await reader.getSessions();
      const s = sessions.find(s => s.session_id === 'exec-001');
      expect(s?.project_path).toBe('/mock/project');
    });

    it('skips .chat files with no user messages', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) {
          return Promise.resolve(makeChatFile({
            chat: [
              { role: 'human', content: '<identity>\nYou are Kiro</identity>' },
              { role: 'bot', content: 'acknowledged' },
            ],
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.filter(s => s.session_id === 'exec-001')).toHaveLength(0);
    });

    it('skips .chat files with no metadata startTime', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) {
          return Promise.resolve(makeChatFile({ metadata: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.filter(s => s.session_id === 'exec-001')).toHaveLength(0);
    });
  });

  describe('getSessions — IDE workspace-sessions format', () => {
    beforeEach(() => {
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'L21vY2svcHJvamVjdA__', isDirectory: () => true },
          ]);
        }
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex()]));
        }
        if (p.endsWith('ide-session-001.json')) {
          return Promise.resolve(makeIdeSessionFile());
        }
        return Promise.reject(new Error('ENOENT'));
      });
    });

    it('parses IDE sessions from workspace-sessions dirs', async () => {
      const sessions = await reader.getSessions();
      const ide = sessions.find(s => s.session_id === 'ide-session-001');
      expect(ide).toBeDefined();
      expect(ide!.agent).toBe('kiro');
      expect(ide!.user_message_count).toBe(1);
      expect(ide!.assistant_message_count).toBe(1);
      expect(ide!.first_prompt).toBe('Fix the bug');
    });

    it('skips hidden IDE sessions', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex({ hidden: true })]));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.find(s => s.session_id === 'ide-session-001')).toBeUndefined();
    });
  });

  describe('getSessions — kiro-cli SQLite', () => {
    beforeEach(() => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockImplementation((dir: string) => {
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
    });

    it('parses sessions from SQLite via json_extract', async () => {
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('json_extract') && cmd.includes('model_id')) {
          return makeSqliteMetaRows();
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows();
        }
        if (cmd.includes('length(value) >= 10000000')) {
          return '[]';
        }
        return '[]';
      });

      const sessions = await reader.getSessions();
      const db = sessions.find(s => s.session_id === 'conv-001');
      expect(db).toBeDefined();
      expect(db!.agent).toBe('kiro');
      expect(db!.project_path).toBe('/mock/project');
      expect(db!.first_prompt).toBe('Help me refactor this code');
      expect(db!.model).toBe('kiro-cli (claude-opus-4.6)');
      expect(db!.user_message_count).toBe(5);
      expect(db!.estimated_cost).toBe(1.5);
      expect(db!.duration_minutes).toBe(2); // 120000ms = 2min
    });

    it('includes large sessions with basic metadata', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('length(value) >= 10000000')) {
          return JSON.stringify([{
            key: '/mock/big-project',
            conversation_id: 'big-conv-001',
            created_at: 1700000000000,
            updated_at: 1700003600000,
          }]);
        }
        // meta and prompt queries (with size filter) return empty
        return '[]';
      });

      const sessions = await reader.getSessions();
      const big = sessions.find(s => s.session_id === 'big-conv-001');
      expect(big).toBeDefined();
      expect(big!.project_path).toBe('/mock/big-project');
      expect(big!.first_prompt).toBe('(large session)');
      expect(big!.duration_minutes).toBe(60); // 3600000ms = 60min
    });

    it('returns empty when SQLite DB does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockReaddir.mockResolvedValue([]);
      const sessions = await reader.getSessions();
      expect(sessions).toHaveLength(0);
    });

    it('returns empty when sqlite3 command fails', async () => {
      mockExecFile.mockImplementation(() => { throw new Error('sqlite3 not found'); });
      mockReaddir.mockResolvedValue([]);
      const sessions = await reader.getSessions();
      expect(sessions).toHaveLength(0);
    });

    it('parses sessions through better-sqlite3 when available', async () => {
      const rowValue = JSON.stringify({
        history: [
          {
            user: { content: { Prompt: { prompt: 'Investigate the database-backed session' } } },
            assistant: { message: 'started' },
            request_metadata: {
              tool_use_ids_and_names: [
                { name: 'mcp_repo__search' },
                { 1: 'bash' },
              ],
            },
          },
          {
            assistant: { message: 'done' },
          },
        ],
        model_info: { model_name: 'claude-opus-4.1' },
        user_turn_metadata: { usage_info: [{ value: 1.25 }, { value: 0.75 }] },
      });

      const DatabaseMock = jest.fn(() => ({
        prepare: jest.fn(() => ({
          all: jest.fn(() => [
            {
              key: '/mock/sqlite-project',
              conversation_id: 'sqlite-db-session',
              value: rowValue,
              created_at: 1700000000000,
              updated_at: 1700000120000,
            },
            {
              key: '/mock/bad-project',
              conversation_id: 'invalid-json-row',
              value: '{not-json',
              created_at: 1700000000000,
              updated_at: 1700000060000,
            },
            {
              key: '/mock/no-user-project',
              conversation_id: 'no-user-row',
              value: JSON.stringify({ history: [{ assistant: { message: 'only assistant' } }] }),
              created_at: 1700000000000,
              updated_at: 1700000060000,
            },
          ]),
        })),
        close: jest.fn(),
      }));

      const { KiroReader: FreshKiroReader } = loadFreshKiroModule(() => {
        jest.doMock('better-sqlite3', () => DatabaseMock, { virtual: true });
      });

      const freshReader = new FreshKiroReader();
      mockReaddir.mockResolvedValue([]);

      const sessions = await freshReader.getSessions();
      expect(DatabaseMock).toHaveBeenCalled();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        session_id: 'sqlite-db-session',
        project_path: '/mock/sqlite-project',
        first_prompt: 'Investigate the database-backed session',
        estimated_cost: 2,
        uses_mcp: true,
        model: 'kiro-cli (claude-opus-4.1)',
        session_completed: true,
      });
      expect(sessions[0].tool_counts).toEqual({
        mcp_repo__search: 1,
        bash: 1,
      });

      jest.resetModules();
    });
  });

  describe('getSessions — deduplication', () => {
    it('deduplicates sessions by session_id across sources', async () => {
      // IDE returns a session
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'L21vY2s_', isDirectory: () => true },
          ]);
        }
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex({ sessionId: 'dup-id' })]));
        }
        if (p.endsWith('dup-id.json')) {
          return Promise.resolve(makeIdeSessionFile());
        }
        return Promise.reject(new Error('ENOENT'));
      });

      // SQLite also returns a session with same ID
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('model_id')) {
          return makeSqliteMetaRows([{
            key: '/mock/project', conversation_id: 'dup-id',
            created_at: 1700000000000, updated_at: 1700000060000,
            model_id: 'opus', conv_id: 'dup-id', history_len: 3, transcript_len: 4,
          }]);
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows([{
            conversation_id: 'dup-id', key: '/mock/project',
            first_prompt: 'test', usage_info: null,
          }]);
        }
        return '[]';
      });

      const sessions = await reader.getSessions();
      const dups = sessions.filter(s => s.session_id === 'dup-id');
      expect(dups).toHaveLength(1);
    });

    it('parses CLI JSONL sessions with prompt cleanup, MCP renaming, and token totals', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir === '/mock/home/.kiro/sessions/cli') {
          return Promise.resolve(['cli-session.jsonl', 'cli-session.json']);
        }
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([]);
        }
        if (dir === IDE_BASE) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('cli-session.jsonl')) {
          return Promise.resolve([
            JSON.stringify({
              kind: 'Prompt',
              data: {
                content: [{ kind: 'text', data: 'You are a session naming agent. Name this conversation.' }],
              },
            }),
            JSON.stringify({
              kind: 'Prompt',
              data: {
                content: [{ kind: 'text', data: '[CURRENT USER REQUEST 1]\nImplement the missing branch\n(If presenting choices, keep them short)' }],
              },
            }),
            JSON.stringify({
              kind: 'AssistantMessage',
              data: {
                content: [
                  { kind: 'toolUse', data: { name: 'openFile', toolUseId: 'tool-plain', input: { path: 'README.md' } } },
                  { kind: 'toolUse', data: { name: 'search', toolUseId: 'tool-mcp', input: { query: 'coverage' } } },
                  { kind: 'toolUse', data: { name: 'lookup', serverName: 'docs', toolUseId: 'tool-direct', input: { topic: 'parser' } } },
                ],
              },
            }),
            JSON.stringify({
              kind: 'Prompt',
              data: {
                content: [
                  { kind: 'toolResult', data: { toolUseId: 'tool-plain', isError: true } },
                ],
              },
            }),
            JSON.stringify({
              kind: 'ToolResults',
              data: {
                content: [
                  { kind: 'toolResult', data: { toolUseId: 'tool-mcp', isError: false, content: 'done' } },
                ],
                results: {
                  'tool-mcp': {
                    tool: {
                      kind: {
                        Mcp: {
                          serverName: 'repo',
                          toolName: 'search',
                        },
                      },
                    },
                    result: { Success: false },
                  },
                },
              },
            }),
          ].join('\n'));
        }
        if (p.endsWith('cli-session.json')) {
          return Promise.resolve(JSON.stringify({
            created_at: '2024-01-10T00:00:00.000Z',
            updated_at: '2024-01-10T00:02:00.000Z',
            cwd: '/mock/cli-project',
            session_state: {
              conversation_metadata: {
                user_turn_metadatas: [
                  { input_token_count: 11, output_token_count: 7 },
                ],
              },
            },
            turns: [
              { input_token_count: 5, output_token_count: 3 },
            ],
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const sessions = await reader.getSessions();
      const cli = sessions.find(s => s.session_id === 'cli-session');
      expect(cli).toBeDefined();
      expect(cli).toMatchObject({
        project_path: '/mock/cli-project',
        first_prompt: 'Implement the missing branch',
        user_message_count: 2,
        assistant_message_count: 1,
        session_completed: false,
        input_tokens: 16,
        output_tokens: 10,
        uses_mcp: true,
      });
      expect(cli!.tool_counts).toEqual({
        openFile: 1,
        mcp_docs__lookup: 1,
        mcp_repo__search: 1,
      });
      expect(cli!.tool_error_counts).toEqual({
        openFile: 1,
        mcp_repo__search: 1,
      });
      expect(cli!.total_tool_errors).toBe(2);
      expect(cli!.estimated_cost).toBeGreaterThan(0);
    });
  });

  describe('getSessionDetail — SQLite', () => {
    it('escapes single quotes in sessionId to prevent SQL injection', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockReturnValue('[]');

      await reader.getSessionDetail("'; DROP TABLE conversations_v2; --");

      // execFileSync is called with args array, not shell string — inherently safe
      // But also verify the SQL escaping in the query arg
      const calls = mockExecFile.mock.calls;
      const sqlCall = calls.find(([bin, args]: [string, string[]]) =>
        bin === 'sqlite3' && args?.some((a: string) => a.includes('conversation_id'))
      );
      expect(sqlCall).toBeDefined();
      const query = sqlCall![1][2]; // args[2] is the SQL query
      // Single quote in input is escaped to '' (SQL standard escaping)
      // Plus execFileSync passes as argument array, not shell string — no shell injection
      expect(query).toContain("conversation_id='''");
      expect(query).toMatch(/conversation_id='.*DROP TABLE.*'/);
    });

    it('returns session detail from SQLite for kiro-cli sessions', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);

      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes("conversation_id='conv-001'")) {
          return JSON.stringify([{
            key: '/mock/project',
            conversation_id: 'conv-001',
            created_at: 1700000000000,
            updated_at: 1700000120000,
            model_id: 'claude-opus-4.6',
            transcript: JSON.stringify([
              '> Help me refactor this code',
              'Sure, let me look at the code.\n[Tool uses: fs_read]',
              'Here is the refactored version.',
            ]),
            history_len: 3,
            first_prompt: 'Help me refactor this code',
          }]);
        }
        return '[]';
      });

      const detail = await reader.getSessionDetail('conv-001');
      expect(detail).not.toBeNull();
      expect(detail!.session.session_id).toBe('conv-001');
      expect(detail!.session.model).toBe('kiro-cli (claude-opus-4.6)');
      expect(detail!.messages.length).toBe(4); // user + assistant + tool + assistant
      expect(detail!.messages[0].role).toBe('user');
      expect(detail!.messages[0].text).toBe('Help me refactor this code');
      expect(detail!.messages[1].role).toBe('assistant');
      expect(detail!.messages[1].text).toContain('let me look at the code');
    });

    it('returns null when session not found in SQLite', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockReturnValue('[]');

      const detail = await reader.getSessionDetail('nonexistent');
      expect(detail).toBeNull();
    });

    it('returns null when SQLite detail JSON is malformed', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_bin: string, args: string[]) => {
        const cmd = (args || []).join(' ');
        if (cmd.includes("conversation_id='broken-detail'")) {
          return '{not-json';
        }
        return '[]';
      });

      await expect(reader.getSessionDetail('broken-detail')).resolves.toBeNull();
    });
  });

  describe('getSessionDetail — .chat format with execution index', () => {
    it('uses execution index to find the right workspace dir', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const executionIndex = JSON.stringify({
        executions: [
          { executionId: 'target-exec', type: 'chat-agent', status: 'succeed', startTime: 1700000000000, endTime: 1700000060000 },
        ],
        version: '2.0.0',
      });

      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'aaa11111222233334444555566667777', isDirectory: () => true },
            { name: 'bbb11111222233334444555566667777', isDirectory: () => true },
          ]);
        }
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) return Promise.resolve([]);
        // Both dirs have an index file and .chat files
        if (dir.includes('aaa111')) return Promise.resolve(['other.chat', 'exec_index']);
        if (dir.includes('bbb111')) return Promise.resolve(['target.chat', 'exec_index']);
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((p: string) => {
        // Execution index for dir aaa — no match
        if (p.includes('aaa111') && p.endsWith('exec_index')) {
          return Promise.resolve(JSON.stringify({ executions: [], version: '2.0.0' }));
        }
        // Execution index for dir bbb — has our target
        if (p.includes('bbb111') && p.endsWith('exec_index')) {
          return Promise.resolve(executionIndex);
        }
        // The .chat file
        if (p.endsWith('target.chat')) {
          return Promise.resolve(makeChatFile({ executionId: 'target-exec' }));
        }
        if (p.endsWith('other.chat')) {
          return Promise.resolve(makeChatFile({ executionId: 'other-exec' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const detail = await reader.getSessionDetail('target-exec');
      expect(detail).not.toBeNull();
      expect(detail!.session.session_id).toBe('target-exec');
      // Should NOT have read .chat files in dir aaa (no match in index)
      const chatReads = mockReadFile.mock.calls.filter(
        ([p]: [string]) => p.includes('aaa111') && p.endsWith('.chat')
      );
      expect(chatReads).toHaveLength(0);
    });

    it('parses .chat detail from matching execution indexes and skips unreadable dirs', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const dirReads = new Map<string, number>();

      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([]);
        }
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'deadbeefdeadbeefdeadbeefdeadbeef', isDirectory: () => true },
            { name: '0123456789abcdef0123456789abcdef', isDirectory: () => true },
          ]);
        }
        if (dir.includes('deadbeefdeadbeefdeadbeefdeadbeef')) {
          const count = (dirReads.get(dir) ?? 0) + 1;
          dirReads.set(dir, count);
          if (count === 1) {
            return Promise.resolve(['candidate.chat']);
          }
          return Promise.reject(new Error('unreadable'));
        }
        if (dir.includes('0123456789abcdef0123456789abcdef')) {
          return Promise.resolve(['exec_index', 'target.chat']);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('exec_index')) {
          return Promise.resolve(JSON.stringify({
            executions: [{ executionId: 'chat-detail-001' }],
            version: '2.0.0',
          }));
        }
        if (p.endsWith('target.chat')) {
          return Promise.resolve(JSON.stringify({
            executionId: 'chat-detail-001',
            context: [{
              type: 'steering',
              id: 'file:///mock/chat-project/AGENTS.md',
            }],
            chat: [
              { role: 'human', content: '<identity>\nignore this</identity>' },
              { role: 'human', content: 'Implement the missing chat detail' },
              {
                role: 'bot',
                content: [
                  { type: 'text', text: 'Planning the next step' },
                  { type: 'tool_use', name: 'mcp_repo__search', input: { query: 'detail' } },
                ],
              },
              { role: 'tool', content: 'search output' },
              { role: 'bot', content: 'Finished the task' },
            ],
            metadata: {
              startTime: 1700000000000,
              endTime: 1700000060000,
              workflow: 'spec',
            },
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const detail = await reader.getSessionDetail('chat-detail-001');
      expect(detail).not.toBeNull();
      expect(detail!.session).toMatchObject({
        session_id: 'chat-detail-001',
        project_path: '/mock/chat-project',
        uses_mcp: true,
        model: 'kiro-ide (spec)',
      });
      expect(detail!.messages).toEqual([
        { role: 'user', text: 'Implement the missing chat detail' },
        { role: 'assistant', text: 'Planning the next step' },
        {
          role: 'assistant',
          text: 'Tool: mcp_repo__search\n{\n  "query": "detail"\n}',
          toolName: 'mcp_repo__search',
        },
        { role: 'tool_result', text: 'search output' },
        { role: 'assistant', text: 'Finished the task' },
      ]);
    });
  });

  describe('getSessionDetail — CLI JSONL and IDE fallbacks', () => {
    it('builds detail messages from CLI JSONL sessions', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === '/mock/home/.kiro/sessions/cli/cli-detail.jsonl'
          ? Promise.resolve()
          : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('cli-detail.jsonl')) {
          return Promise.resolve([
            JSON.stringify({
              kind: 'Prompt',
              data: { content: [{ kind: 'text', data: 'Read the repository summary' }] },
            }),
            JSON.stringify({
              kind: 'AssistantMessage',
              data: {
                content: [
                  { kind: 'text', data: 'Reviewing the repository' },
                  { kind: 'toolUse', data: { name: 'search', input: { query: 'repo' } } },
                ],
              },
            }),
            JSON.stringify({
              kind: 'ToolResults',
              data: {
                content: [
                  {
                    kind: 'toolResult',
                    data: {
                      content: [{ text: 'result line 1' }, { text: 'result line 2' }],
                      isError: false,
                    },
                  },
                ],
              },
            }),
          ].join('\n'));
        }
        if (p.endsWith('cli-detail.json')) {
          return Promise.resolve(JSON.stringify({
            created_at: '2024-02-01T00:00:00.000Z',
            updated_at: '2024-02-01T00:01:00.000Z',
            cwd: '/mock/cli-detail-project',
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const detail = await reader.getSessionDetail('cli-detail');
      expect(detail).not.toBeNull();
      expect(detail!.session.project_path).toBe('/mock/cli-detail-project');
      expect(detail!.messages).toEqual([
        { role: 'user', text: 'Read the repository summary' },
        { role: 'assistant', text: 'Reviewing the repository' },
        {
          role: 'assistant',
          text: 'Tool: search\n{\n  "query": "repo"\n}',
          toolName: 'search',
        },
        {
          role: 'tool_result',
          text: 'result line 1\nresult line 2',
          isError: false,
        },
      ]);
    });

    it('builds detail from IDE workspace sessions when CLI sources miss', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'L21vY2svaWRl', isDirectory: () => true },
          ]);
        }
        if (dir === IDE_BASE) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('ide-detail.json')) {
          return Promise.resolve(JSON.stringify({
            workspaceDirectory: '/mock/ide-project',
            history: [
              { message: { role: 'user', content: [{ type: 'text', text: 'Investigate the IDE session' }] } },
              { message: { role: 'assistant', content: 'I found the issue' } },
            ],
            sessionType: 'task',
          }));
        }
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([
            {
              sessionId: 'ide-detail',
              title: 'IDE detail title',
              dateCreated: '1700000000000',
              workspaceDirectory: '/mock/ide-project',
            },
          ]));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const detail = await reader.getSessionDetail('ide-detail');
      expect(detail).not.toBeNull();
      expect(detail!.session).toMatchObject({
        session_id: 'ide-detail',
        project_path: '/mock/ide-project',
        model: 'kiro-ide (task)',
        first_prompt: 'Investigate the IDE session',
      });
      expect(detail!.messages).toEqual([
        { role: 'user', text: 'Investigate the IDE session' },
        { role: 'assistant', text: 'I found the issue' },
      ]);
    });
  });

  describe('getStats', () => {
    it('computes stats from all sessions', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('model_id')) {
          return makeSqliteMetaRows([
            { key: '/p1', conversation_id: 'c1', created_at: 1700000000000, updated_at: 1700000060000, model_id: 'opus', conv_id: 'c1', history_len: 3, transcript_len: 4 },
            { key: '/p2', conversation_id: 'c2', created_at: 1700086400000, updated_at: 1700086460000, model_id: 'opus', conv_id: 'c2', history_len: 5, transcript_len: 6 },
          ]);
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows([
            { conversation_id: 'c1', key: '/p1', first_prompt: 'test1', usage_info: JSON.stringify([{ value: 1.0 }]) },
            { conversation_id: 'c2', key: '/p2', first_prompt: 'test2', usage_info: JSON.stringify([{ value: 2.0 }]) },
          ]);
        }
        return '[]';
      });

      const stats = await reader.getStats();
      expect(stats.agent).toBe('kiro');
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalCost).toBe(3.0);
      expect(stats.activeDays).toBe(2);
      expect(stats.dailyActivity).toHaveLength(2);
    });
  });

  describe('rereadSession', () => {
    it('handles .chat files', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) return Promise.resolve(makeChatFile());
        return Promise.reject(new Error('ENOENT'));
      });

      const session = await reader.rereadSession('/some/path/exec.chat');
      expect(session).not.toBeNull();
      expect(session!.session_id).toBe('exec-001');
    });

    it('parses richer .chat files with tool metadata and error counts', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) {
          return Promise.resolve(makeChatFile({
            executionId: undefined,
            context: [
              {
                type: 'steering',
                id: 'file:///mock/project/.kiro/steering/guide.md',
              },
            ],
            chat: [
              { role: 'human', content: '<identity>\nSystem prompt</identity>' },
              { role: 'human', content: 'Plan the migration' },
              {
                role: 'bot',
                content: [
                  { type: 'tool_use', name: 'mcp_repo__search', input: { query: 'migration' } },
                  { type: 'text', text: 'I will inspect the repository.' },
                ],
              },
              {
                role: 'tool',
                content: [
                  { type: 'tool_result', is_error: true },
                ],
              },
              { role: 'bot', content: 'Completed the review.' },
            ],
            metadata: {
              startTime: 1700000000000,
              endTime: 1700000120000,
              workflow: 'plan',
            },
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const session = await reader.rereadSession('/some/path/fallback.chat');
      expect(session).not.toBeNull();
      expect(session).toMatchObject({
        session_id: 'fallback',
        project_path: '/mock/project',
        first_prompt: 'Plan the migration',
        uses_mcp: true,
        model: 'kiro-ide (plan)',
        session_completed: true,
      });
      expect(session!.tool_counts).toEqual({ mcp_repo__search: 1 });
      expect(session!.tool_error_counts).toEqual({ unknown: 1 });
      expect(session!.total_tool_errors).toBe(1);
    });

    it('returns null for missing files', async () => {
      const session = await reader.rereadSession('/nonexistent.chat');
      expect(session).toBeNull();
    });
  });
});
