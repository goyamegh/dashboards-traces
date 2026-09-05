/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a subprocess coding-agent run persists an auditable
 * `agentSession` on its report — what the agent HAD ACCESS TO (skills,
 * plugins, tools, MCP servers, model, permission mode, version), what it
 * USED (tools, skills), what it was DENIED (permission denials + errored
 * tools) and what it COST (turns / usd / tokens).
 *
 * Real path end-to-end with only the judge stubbed:
 *   executeEvaluationRun → invokeAgent → ClaudeCodeConnector (singleton)
 *     → child_process.spawn(<fake claude binary>) emitting a realistic
 *       stream-json session (init → Skill tool_use → ToolSearch miss →
 *       result with one permission denial)
 *     → report persisted through the real FileStorageModule
 *
 * Pre-fix the connector kept only `session_id` from `system/init` and
 * dropped everything else, so a report could not answer "which skills did
 * the agent have, which did it use, what did it try that was refused?".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import type { EvaluationRun, TestCase } from '@/types';

const FAKE_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-audit-bin-'));
const FAKE_CLAUDE = path.join(FAKE_BIN_DIR, 'fake-claude');

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      {
        key: 'subprocess-agent',
        name: 'Subprocess Agent',
        endpoint: FAKE_CLAUDE,
        connectorType: 'claude-code',
        useTraces: false,
        connectorConfig: { timeout: 20_000 },
      },
    ],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  })),
}));
jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } } },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(async () => ({
    passFailStatus: 'passed',
    metrics: { accuracy: 100 },
    llmJudgeReasoning: 'stub',
    improvementStrategies: [],
    judgeDurationMs: 1,
  })),
  simulateBedrockJudge: jest.fn(),
}));

/**
 * Fake `claude --print --verbose --output-format stream-json`. Event shapes
 * mirror the real CLI's `system/init` and `result` keys (no internal data).
 */
const FAKE_CLAUDE_SRC = `
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const sid = 'sess-audit-1';
  const ev = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid, uuid: 'u-' + Math.random() }) + '\\n');
  ev({
    type: 'system', subtype: 'init',
    claude_code_version: '2.1.201', model: 'claude-sonnet-4-5', permissionMode: 'default',
    cwd: process.cwd(), apiKeySource: 'none', output_style: 'default',
    tools: ['Read', 'Grep', 'Glob', 'Skill', 'ToolSearch', 'mcp__search__query'],
    skills: ['opensearch-dsl', 'deep-research', 'unused-skill'],
    plugins: [{ name: 'plugin-a', path: '/home/x/.claude/plugins/a', source: 'user' }],
    mcp_servers: [{ name: 'search', status: 'connected' }],
    agents: ['Explore'], memory_paths: ['/repo/CLAUDE.md'], slash_commands: ['help'],
  });
  ev({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'opensearch-dsl' } },
  ] } });
  ev({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'skill loaded' },
  ] } });
  ev({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't2', name: 'ToolSearch', input: { query: 'Bash' } },
    { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/repo/README.md' } },
  ] } });
  ev({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'No matching deferred tools found' },
    { type: 'tool_result', tool_use_id: 't3', content: '# README' },
  ] } });
  ev({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
    duration_ms: 4321, duration_api_ms: 3210, num_turns: 4, total_cost_usd: 0.0421,
    usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 250 },
    modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1200, outputTokens: 250 } },
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 't-denied', tool_input: { command: 'cat /etc/passwd' } }],
    result: 'The README describes the project.',
  });
  setTimeout(() => process.exit(0), 50);
});
`;

function makeTestCase(): TestCase {
  return {
    id: 'tc-audit',
    name: 'Audit case',
    initialPrompt: 'What does the README say?',
    context: [],
    expectedOutcomes: ['reads the README'],
    labels: [],
    currentVersion: 1,
  } as unknown as TestCase;
}

function makeRun(): EvaluationRun {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Agent session audit',
    agentKey: 'subprocess-agent',
    modelId: 'claude-sonnet',
    status: 'running',
    concurrency: 1,
    results: {},
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

describe('subprocess-agent run persists an auditable agentSession (integration, real spawn + file storage)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    fs.writeFileSync(`${FAKE_CLAUDE}.js`, FAKE_CLAUDE_SRC);
    fs.writeFileSync(FAKE_CLAUDE, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}.js" "$@"\n`);
    fs.chmodSync(FAKE_CLAUDE, 0o755);
  });
  afterAll(() => {
    fs.rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-audit-'));
    storage = new FileStorageModule(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the persisted report records access (skills/tools/plugins/mcp), use (toolsUsed/skillsInvoked), denials, and cost', async () => {
    const tc = makeTestCase();
    const run = makeRun();

    await executeEvaluationRun(run, [tc], { storageModule: storage as any, onProgress: jest.fn() });

    const report = (await storage.runs.getById((run.results as any)['tc-audit'].reportId)) as any;
    expect(report).toBeTruthy();
    expect(report.sessionId).toBe('sess-audit-1'); // pre-existing contract intact

    const s = report.agentSession;
    expect(s).toBeTruthy();
    // ACCESS
    expect(s.agentVersion).toBe('2.1.201');
    expect(s.model).toBe('claude-sonnet-4-5');
    expect(s.permissionMode).toBe('default');
    expect(s.skills).toEqual(['opensearch-dsl', 'deep-research', 'unused-skill']);
    expect(s.tools).toEqual(['Read', 'Grep', 'Glob', 'Skill', 'ToolSearch', 'mcp__search__query']);
    expect(s.plugins).toEqual([{ name: 'plugin-a', source: 'user' }]);
    expect(s.mcpServers).toEqual([{ name: 'search', status: 'connected' }]);
    expect(s.agents).toEqual(['Explore']);
    expect(s.memoryPaths).toEqual(['/repo/CLAUDE.md']);
    // USE
    expect(s.toolsUsed).toEqual(['Skill', 'ToolSearch', 'Read']);
    expect(s.skillsInvoked).toEqual(['opensearch-dsl']);
    // DENIED
    expect(s.permissionDenials).toHaveLength(1);
    expect(s.permissionDenials[0].tool_name).toBe('Bash');
    expect(s.toolErrors).toEqual([{ toolName: 'ToolSearch', count: 1, firstError: 'No matching deferred tools found' }]);
    // COST
    expect(s.numTurns).toBe(4);
    expect(s.totalCostUsd).toBe(0.0421);
    expect(s.durationApiMs).toBe(3210);
    expect(s.usage).toEqual({ inputTokens: 1200, outputTokens: 250, cacheCreationInputTokens: 300, cacheReadInputTokens: 4000 });
    expect(s.isError).toBe(false);
    expect(s.stopReason).toBe('end_turn');

    // The trajectory itself is unchanged by the capture (no synthetic steps).
    expect(report.trajectory.at(-1)).toMatchObject({ type: 'response', content: 'The README describes the project.' });
    expect(report.trajectory.filter((st: any) => st.type === 'action')).toHaveLength(3);
  }, 30_000);
});
