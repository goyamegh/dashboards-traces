/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the MCP command's tool wiring.
 *
 * buildTools() is the only logic worth testing in isolation: every tool must
 * map to the right ApiClient method and wrap its return as MCP text content.
 * The transport/server glue is exercised by the integration test.
 */

import { buildTools } from '@/cli/commands/mcp';
import type { ApiClient } from '@/cli/utils/apiClient';

function mockApi() {
  return {
    listAgents: jest.fn().mockResolvedValue([{ key: 'demo' }]),
    listModels: jest.fn().mockResolvedValue([{ key: 'm1' }]),
    listTestCasesWithMeta: jest.fn().mockResolvedValue({ data: [], total: 0, meta: {} }),
    listBenchmarksWithMeta: jest.fn().mockResolvedValue({ data: [], total: 0, meta: {} }),
    listEvaluators: jest.fn().mockResolvedValue({ evaluators: [], total: 0, meta: {} }),
    findTestCase: jest.fn().mockResolvedValue({ id: 'tc-1', name: 'TC' }),
    findBenchmark: jest.fn().mockResolvedValue({ id: 'b-1', name: 'B' }),
    getReportById: jest.fn().mockResolvedValue({ id: 'r-1', status: 'completed' }),
    exportBenchmark: jest.fn().mockResolvedValue([{ name: 'tc' }]),
    fetchTraces: jest.fn().mockResolvedValue({ spans: [], total: 0, hasMore: false }),
    runEvaluation: jest.fn().mockResolvedValue({ id: 'r-1', status: 'completed', trajectorySteps: 3 }),
    executeBenchmark: jest.fn().mockResolvedValue({ id: 'run-1', status: 'completed' }),
  };
}

function tool(api: any, name: string) {
  const t = buildTools(api as unknown as ApiClient).find(t => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

async function callText(api: any, name: string, args: any = {}) {
  const result = await tool(api, name).handler(args);
  return result.content[0].text;
}

describe('buildTools', () => {
  it('registers a stable set of tools', () => {
    const names = buildTools(mockApi() as unknown as ApiClient).map(t => t.name).sort();
    expect(names).toEqual([
      'export_benchmark',
      'fetch_traces',
      'get_benchmark',
      'get_report',
      'get_test_case',
      'list_agents',
      'list_benchmarks',
      'list_evaluators',
      'list_models',
      'list_test_cases',
      'run_benchmark',
      'run_evaluation',
    ]);
  });

  it('every tool has a non-empty description', () => {
    for (const t of buildTools(mockApi() as unknown as ApiClient)) {
      expect(t.config.description.length).toBeGreaterThan(0);
    }
  });

  describe('read tools call the matching ApiClient method', () => {
    it('list_agents → listAgents and wraps the result as JSON text', async () => {
      const api = mockApi();
      const text = await callText(api, 'list_agents');
      expect(api.listAgents).toHaveBeenCalledTimes(1);
      expect(JSON.parse(text)).toEqual([{ key: 'demo' }]);
    });

    it('list_test_cases → listTestCasesWithMeta', async () => {
      const api = mockApi();
      await callText(api, 'list_test_cases');
      expect(api.listTestCasesWithMeta).toHaveBeenCalledTimes(1);
    });

    it('get_test_case forwards the identifier to findTestCase', async () => {
      const api = mockApi();
      await callText(api, 'get_test_case', { identifier: 'my-tc' });
      expect(api.findTestCase).toHaveBeenCalledWith('my-tc');
    });

    it('get_benchmark forwards the identifier to findBenchmark', async () => {
      const api = mockApi();
      await callText(api, 'get_benchmark', { identifier: 'my-bench' });
      expect(api.findBenchmark).toHaveBeenCalledWith('my-bench');
    });

    it('get_report forwards reportId to getReportById', async () => {
      const api = mockApi();
      await callText(api, 'get_report', { reportId: 'r-9' });
      expect(api.getReportById).toHaveBeenCalledWith('r-9');
    });

    it('fetch_traces forwards the whole filter object', async () => {
      const api = mockApi();
      const args = { runIds: ['run-1'], serviceName: 'pi-agent', size: 50 };
      await callText(api, 'fetch_traces', args);
      expect(api.fetchTraces).toHaveBeenCalledWith(args);
    });
  });

  describe('action tools', () => {
    it('run_evaluation forwards args in ApiClient order', async () => {
      const api = mockApi();
      await callText(api, 'run_evaluation', {
        testCaseId: 'tc-1', agentKey: 'demo', modelId: 'm1', evaluatorId: 'ev-1', judgeModelId: 'j-1',
      });
      expect(api.runEvaluation).toHaveBeenCalledWith('tc-1', 'demo', 'm1', undefined, 'ev-1', 'j-1');
    });

    it('run_benchmark builds a RunConfigInput with a default name', async () => {
      const api = mockApi();
      await callText(api, 'run_benchmark', { benchmarkId: 'b-1', agentKey: 'demo', modelId: 'm1' });
      const [id, runConfig] = api.executeBenchmark.mock.calls[0];
      expect(id).toBe('b-1');
      expect(runConfig.agentKey).toBe('demo');
      expect(runConfig.modelId).toBe('m1');
      expect(typeof runConfig.name).toBe('string');
      expect(runConfig.evaluatorId).toBeUndefined();
    });

    it('run_benchmark includes evaluatorId only when provided', async () => {
      const api = mockApi();
      await callText(api, 'run_benchmark', { benchmarkId: 'b-1', agentKey: 'demo', modelId: 'm1', evaluatorId: 'ev-2', name: 'nightly' });
      const [, runConfig] = api.executeBenchmark.mock.calls[0];
      expect(runConfig.evaluatorId).toBe('ev-2');
      expect(runConfig.name).toBe('nightly');
    });
  });
});
