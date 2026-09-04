/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: concurrent subprocess-agent runs must persist their OWN
 * `sessionId` (P0, cross-run data corruption).
 *
 * Exercises the REAL path end-to-end with only the judge stubbed:
 *   executeEvaluationRun (concurrency=2)
 *     → invokeAgent → connectorRegistry → ClaudeCodeConnector (singleton)
 *     → child_process.spawn(<fake claude binary>)  ← real process, real
 *       stdout chunking, real `close` ordering
 *     → report persisted through the real FileStorageModule
 *
 * The fake binary emits stream-json whose `session_id` is derived from the
 * prompt it receives on stdin, and paces its output so the two children
 * interleave in the exact order that corrupted live runs: case A writes all
 * its events, case B writes its `init` (re-stamping the shared instance
 * field pre-fix), THEN case A's process closes and its result is assembled.
 *
 * Pre-fix, report A carried `sess-B` — so Strategy D (session.id) trace
 * correlation fetched case B's spans and case A was judged on case B's
 * tool calls. Measured live: 11/62 reports of one benchmark cross-wired.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import type { EvaluationRun, TestCase } from '@/types';

const FAKE_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-bin-'));
const FAKE_CLAUDE = path.join(FAKE_BIN_DIR, 'fake-claude');

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      {
        key: 'subprocess-agent',
        name: 'Subprocess Agent',
        // SubprocessConnector spawns `endpoint || config.command`.
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
// Judge is the only stub: it would need Bedrock. Everything else is real.
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
 * Fake `claude --print --output-format stream-json`: reads the prompt from
 * stdin, derives a session id from the case marker in it, and emits events on
 * a schedule chosen per case so the two concurrent children interleave
 * deterministically (A: everything early, closes late; B: init in A's gap).
 */
const FAKE_CLAUDE_SRC = `
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString();
  const m = prompt.match(/CASE-([A-Z])/);
  const c = m ? m[1] : 'X';
  const sid = 'sess-' + c;
  const ev = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\\n');
  const schedule = c === 'A'
    ? [[0, () => ev({ type: 'system', subtype: 'init' })],
       [50, () => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't-' + c, name: 'Read', input: { p: c } }] } })],
       [100, () => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-' + c, content: 'output for ' + c }] } })],
       [150, () => ev({ type: 'result', result: 'answer ' + c })],
       [700, () => process.exit(0)]]
    : [[400, () => ev({ type: 'system', subtype: 'init' })],
       [1000, () => ev({ type: 'result', result: 'answer ' + c })],
       [1100, () => process.exit(0)]];
  for (const [ms, fn] of schedule) setTimeout(fn, ms);
});
`;

function makeTestCase(id: string, marker: string): TestCase {
  return {
    id,
    name: `Case ${marker}`,
    initialPrompt: `CASE-${marker}: what is in the file?`,
    context: [],
    expectedOutcomes: ['reads the file'],
    labels: [],
    currentVersion: 1,
  } as unknown as TestCase;
}

function makeRun(): EvaluationRun {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Concurrent session-id isolation',
    agentKey: 'subprocess-agent',
    modelId: 'claude-sonnet',
    status: 'running',
    concurrency: 2,
    results: {},
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

describe('concurrent subprocess-agent runs keep their own sessionId (integration, real spawn + file storage)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(() => {
    fs.writeFileSync(`${FAKE_CLAUDE}.js`, FAKE_CLAUDE_SRC);
    // Wrapper so the connector can spawn it as a plain command with its own
    // `--print --verbose --output-format stream-json` args (ignored here).
    fs.writeFileSync(FAKE_CLAUDE, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}.js" "$@"\n`);
    fs.chmodSync(FAKE_CLAUDE, 0o755);
  });
  afterAll(() => {
    fs.rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-session-'));
    storage = new FileStorageModule(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two concurrent runs persist distinct, correct sessionIds and un-mixed trajectories', async () => {
    const tcA = makeTestCase('tc-A', 'A');
    const tcB = makeTestCase('tc-B', 'B');
    const run = makeRun();

    await executeEvaluationRun(run, [tcA, tcB], {
      storageModule: storage as any,
      onProgress: jest.fn(),
    });

    const reportA = (await storage.runs.getById((run.results as any)['tc-A'].reportId)) as any;
    const reportB = (await storage.runs.getById((run.results as any)['tc-B'].reportId)) as any;
    expect(reportA).toBeTruthy();
    expect(reportB).toBeTruthy();

    // The whole point: each report carries the session id ITS child emitted.
    expect(reportA.sessionId).toBe('sess-A');
    expect(reportB.sessionId).toBe('sess-B');
    expect(reportA.sessionId).not.toBe(reportB.sessionId);

    // Trajectories did not bleed across the shared connector instance either
    // (the NDJSON line buffer was instance state too).
    const contentsA = reportA.trajectory.map((s: any) => s.content);
    const contentsB = reportB.trajectory.map((s: any) => s.content);
    expect(contentsA).toContain('answer A');
    expect(contentsA).not.toContain('answer B');
    expect(contentsB).toContain('answer B');
    expect(contentsB).not.toContain('answer A');

    // And the paired tool result carries its real output (P1 fix), not a stub.
    const trA = reportA.trajectory.find((s: any) => s.type === 'tool_result');
    expect(trA).toMatchObject({ toolName: 'Read', toolOutput: 'output for A', content: 'output for A' });
    expect(reportB.trajectory.some((s: any) => s.type === 'tool_result')).toBe(false);
  }, 30_000);
});
