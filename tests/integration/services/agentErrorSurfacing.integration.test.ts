/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: agent-error surfacing through the REAL service code.
 *
 * The REAL `RESTConnector` (real `fetch`) against real local HTTP servers,
 * driven through the REAL `runEvaluationWithConnector`, with a judge endpoint
 * that counts hits:
 *   • the agent closes the socket without answering (what undici reports as
 *     the opaque `TypeError: fetch failed` with the real reason on `cause`) →
 *     failureStage 'agent', kind 'connection', `error` carries the unwrapped
 *     cause (never the bare `fetch failed`), judge hit 0 times;
 *   • the agent answers 503 → failureStage 'agent', kind 'http_503', judge
 *     hit 0 times.
 *
 * Boots its own servers on ephemeral ports — does NOT need AH_PORT.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { isJudgeFailedCase } from '@/services/evaluation/retryJudgement';
import { ENV_CONFIG } from '@/lib/config';
import type { AgentConfig, TestCase } from '@/types';
import type { ConnectorRegistry } from '@/services/connectors/types';

function buildTestCase(): TestCase {
  const now = new Date().toISOString();
  return {
    id: 'tc-agent-failure', name: 'agent failure case', description: '', labels: [], currentVersion: 1,
    versions: [{ version: 1, createdAt: now, initialPrompt: 'What is the answer?', context: [], expectedOutcomes: ['Answers'] }],
    isPromoted: false, createdAt: now, updatedAt: now,
    initialPrompt: 'What is the answer?', context: [], expectedOutcomes: ['Answers'],
  } as unknown as TestCase;
}

function restRegistry(): ConnectorRegistry {
  const connector = new RESTConnector();
  return { getForAgent: () => connector } as unknown as ConnectorRegistry;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/ask`;
}

describe('agent-error surfacing (integration, real RESTConnector + real HTTP)', () => {
  let judgeServer: http.Server;
  let judgeHits = 0;

  beforeAll(async () => {
    judgeServer = http.createServer((_req, res) => { judgeHits++; res.end('{}'); });
    await new Promise<void>(r => judgeServer.listen(0, '127.0.0.1', r));
    (ENV_CONFIG as any).judgeApiUrl = `http://127.0.0.1:${(judgeServer.address() as AddressInfo).port}/api/judge`;
  });
  afterAll(async () => {
    await new Promise<void>(r => judgeServer.close(() => r()));
    (ENV_CONFIG as any).judgeApiUrl = undefined;
  });
  beforeEach(() => {
    judgeHits = 0;
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('agent closes the connection without answering → agent-stage failure with the unwrapped cause, judge never called', async () => {
    // The "agent": accepts the request and destroys the socket. undici throws
    // `TypeError: fetch failed` with the real reason on `cause`.
    const srv = http.createServer((req) => { req.socket.destroy(); });
    const url = await listen(srv);
    try {
      const agent = { key: 'example-rest-agent', name: 'A REST agent', endpoint: url, connectorType: 'rest', useTraces: false } as unknown as AgentConfig;
      const report = await runEvaluationWithConnector(agent, 'test-model', buildTestCase(), () => {}, {
        registry: restRegistry(), judgeModelId: 'agent-trace-judge',
      }) as any;

      // Stage + shape: terminal from the outset, no verdict, not judged.
      expect(report.failureStage).toBe('agent');
      expect(report.status).toBe('failed');
      expect(report.metricsStatus).toBe('error');
      expect(report.passFailStatus).toBeNull();
      expect(report.trajectory).toEqual([]);
      expect(report.skipJudge).toBe(true);

      // The REAL cause — not the opaque wrapper.
      expect(report.error).not.toMatch(/fetch failed/);
      expect(report.error).toMatch(/ECONNRESET|socket|closed|UND_ERR/i);
      expect(report.error).toContain(url);
      expect(report.agentError).toEqual(expect.objectContaining({ kind: 'connection', endpoint: url }));
      expect(report.agentError.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(report.traceError).toMatch(/^Agent request failed \(kind=agent_failed\)/);
      expect(report.llmJudgeReasoning).toMatch(/Agent request failed — not judged/);
      expect(report.llmJudgeReasoning).not.toMatch(/Evaluator could not run/);

      // The judge was never invoked for an agent that produced nothing.
      expect(judgeHits).toBe(0);
      // Retry-judgement must not offer it.
      expect(isJudgeFailedCase(report, { reportId: 'r', status: 'completed' })).toBe(false);
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  }, 20_000);

  it('a non-2xx agent reply is an agent-stage http_<status> failure (judge not called)', async () => {
    const srv = http.createServer((_req, res) => { res.statusCode = 503; res.end('Service Unavailable'); });
    const url = await listen(srv);
    try {
      const agent = { key: 'a', name: 'A REST agent', endpoint: url, connectorType: 'rest', useTraces: false } as unknown as AgentConfig;
      const report = await runEvaluationWithConnector(agent, 'm', buildTestCase(), () => {}, { registry: restRegistry() }) as any;
      expect(report.failureStage).toBe('agent');
      expect(report.agentError.kind).toBe('http_503');
      expect(report.agentError.httpStatus).toBe(503);
      expect(report.error).toMatch(/REST request failed: 503 - Service Unavailable/);
      expect(judgeHits).toBe(0);
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  });
});
