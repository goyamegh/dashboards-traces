/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a REST-connector `useTraces` run whose spans carry NO tool
 * payloads must keep its hook-built `tool_result` steps after the trace
 * poller runs (P0, judge evidence loss).
 *
 * Real path end-to-end, with only the OpenSearch span fetch and the Bedrock
 * judge stubbed:
 *   executeEvaluationRun
 *     → invokeAgent → RESTConnector → real HTTP call to a local agent
 *     → afterResponse hook builds action/tool_result steps WITH toolOutput
 *       (the shape a REST retrieval agent's hook produces)
 *     → report persisted (metricsStatus: pending) via the real FileStorageModule
 *     → tracePollingManager polls (real), fetchTracesForRun → spans whose only
 *       attributes are the prompt/completion (no tool spans / payloads)
 *     → spansToTrajectory → merge → judge (stub) → report updated on disk.
 *
 * Pre-fix the poller REPLACED the connector trajectory with the span-derived
 * one and appended only the response: the persisted trajectory ended as
 * `[thinking, response]` with zero tool steps (measured live: 30/62 reports
 * of one run) and the judge wrote "no intermediate retrieval steps".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import type { EvaluationRun, TestCase } from '@/types';

// Populated once the local agent is listening; read lazily by the config mock.
let agentUrl = '';
let storageRef: FileStorageModule | null = null;

const TOOL_OUTPUT = JSON.stringify({
  hits: [
    { id: 597374, title: 'Away Kit 2014-15', brand: 'adidas' },
    { id: 12, title: 'Home Kit', brand: 'adidas' },
  ],
});

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      {
        key: 'rest-retrieval-agent',
        name: 'REST Retrieval Agent',
        endpoint: agentUrl,
        connectorType: 'rest',
        useTraces: true,
        // Strategy C correlator (service.name + run window) — the report has
        // no runId (REST) and, with eval telemetry off in tests, no traceId.
        traceServiceName: 'retrieval-agent',
        // Fast poll budget: one attempt is enough — spans are returned first try.
        tracePolling: { intervalMs: 5, maxAttempts: 3 },
        hooks: {
          // Mirrors a real REST agent's hook: turn the agent's `steps[]`
          // into action + tool_result trajectory steps carrying the output.
          afterResponse: async (ctx: any) => {
            const data = ctx.rawEvents?.[0] ?? {};
            const trajectory: any[] = [];
            for (const s of data.steps ?? []) {
              trajectory.push({ id: `a-${s.n}`, timestamp: Date.now(), type: 'action', content: JSON.stringify(s.args), toolName: s.tool, toolArgs: s.args });
              trajectory.push({ id: `r-${s.n}`, timestamp: Date.now(), type: 'tool_result', content: `${s.tool}(${JSON.stringify(s.args)}) -> ${s.output}`, toolName: s.tool, toolOutput: s.output, status: 'SUCCESS' });
            }
            trajectory.push({ id: 'resp', timestamp: Date.now(), type: 'response', content: data.answer });
            return { ...ctx, trajectory };
          },
        },
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
// The poller's storage client speaks HTTP to a server; bridge it to the
// in-test FileStorageModule so the poller reads/writes the SAME documents the
// runner persisted (no server required).
jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: {
    getReportById: async (id: string) => (storageRef ? storageRef.runs.getById(id) : null),
    updateReport: async (id: string, patch: any) => (storageRef ? storageRef.runs.update(id, patch) : null),
  },
}));
// Spans: prompt/completion only — no tool spans, no tool payloads. This is the
// live shape for a REST agent whose OTel instrumentation covers the LLM call
// but not the tool executions.
jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(async () => ({
    spans: [{
      traceId: 'trace-rest-1',
      spanId: 'span-root',
      name: 'invoke_agent retrieval-agent',
      startTime: new Date(Date.now() - 2000).toISOString(),
      endTime: new Date().toISOString(),
      duration: 2000,
      status: 'OK',
      attributes: { 'gen_ai.prompt': 'find the adidas away kit', 'gen_ai.completion': 'The product is 597374.' },
    }],
    total: 1,
  })),
}));

import { callBedrockJudge } from '@/services/evaluation/bedrockJudge';

const TC: TestCase = {
  id: 'tc-rest-1',
  name: 'Find the away kit',
  initialPrompt: 'find the adidas away kit',
  context: [],
  expectedOutcomes: ['returns product 597374'],
  labels: [],
  currentVersion: 1,
} as unknown as TestCase;

function makeRun(): EvaluationRun {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'REST evidence merge',
    agentKey: 'rest-retrieval-agent',
    modelId: 'claude-sonnet',
    status: 'running',
    concurrency: 1,
    results: {},
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

describe('REST connector + payload-less spans: hook-built tool_result steps survive the trace poller (integration)', () => {
  let server: http.Server;
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          answer: 'The product is 597374.',
          steps: [
            { n: 0, tool: 'get_index_profile', args: { index: 'kb' }, output: '{"fields":["title","brand"]}' },
            { n: 1, tool: 'dsl_executor', args: { index: 'kb', q: 'adidas away kit' }, output: TOOL_OUTPUT },
          ],
          echo: body.length,
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/run`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-evidence-merge-'));
    storage = new FileStorageModule(tmpDir);
    storageRef = storage;
    (callBedrockJudge as jest.Mock).mockClear();
  });
  afterEach(() => {
    storageRef = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the judged trajectory WITH the hook-built tool_result steps and their toolOutput', async () => {
    const run = makeRun();
    await executeEvaluationRun(run, [TC], { storageModule: storage as any, onProgress: jest.fn() });

    const result = (run.results as any)[TC.id];
    expect(result.status).toBe('completed');
    const saved = (await storage.runs.getById(result.reportId)) as any;
    expect(saved).toBeTruthy();
    expect(saved.metricsStatus).toBe('ready');
    expect(saved.passFailStatus).toBe('passed');

    const toolResults = saved.trajectory.filter((s: any) => s.type === 'tool_result');
    const actions = saved.trajectory.filter((s: any) => s.type === 'action');
    expect(actions.map((s: any) => s.toolName)).toEqual(['get_index_profile', 'dsl_executor']);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1].toolOutput).toBe(TOOL_OUTPUT);
    expect(toolResults[0].toolOutput).toBe('{"fields":["title","brand"]}');
    // The agent's answer is still there, exactly once.
    expect(saved.trajectory.filter((s: any) => s.type === 'response')).toHaveLength(1);

    // And the JUDGE graded that same evidence-bearing trajectory.
    expect(callBedrockJudge).toHaveBeenCalledTimes(1);
    const judged = (callBedrockJudge as jest.Mock).mock.calls[0][0];
    expect(judged.filter((s: any) => s.type === 'tool_result').map((s: any) => s.toolOutput)).toEqual([
      '{"fields":["title","brand"]}',
      TOOL_OUTPUT,
    ]);
  }, 30_000);
});
