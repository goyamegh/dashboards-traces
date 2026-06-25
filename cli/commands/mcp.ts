/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Command
 *
 * Runs Agent Health as an MCP (Model Context Protocol) server over stdio,
 * so MCP-compatible agents (Claude Desktop, Cursor, etc.) can natively
 * interact with evaluation data, run experiments, and inspect traces.
 *
 * Architecture: MCP client → this stdio server → ApiClient → local HTTP API.
 * This is a transport adapter only — every tool maps 1:1 to an existing
 * ApiClient method, so there is no new business logic to maintain.
 *
 * Claude Desktop config:
 *   { "mcpServers": { "agent-health": {
 *       "command": "npx",
 *       "args": ["@opensearch-project/agent-health", "mcp"] } } }
 */

import { Command } from 'commander';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '@/cli/utils/apiClient.js';

/** Wrap any value as MCP text content. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** A registerable MCP tool. `inputSchema` omitted ⇒ no-argument tool. */
export interface McpTool {
  name: string;
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: any) => Promise<ReturnType<typeof json>>;
}

/**
 * Build the tool set. Pure and testable: every handler is one ApiClient call
 * wrapped as MCP text content. No server/transport coupling here.
 *
 * ponytail: errors thrown by ApiClient are caught by the SDK's tool wrapper
 * and returned as `isError` results — no per-handler try/catch needed.
 */
export function buildTools(api: ApiClient): McpTool[] {
  return [
    // ── Read: catalogs ──────────────────────────────────────────────
    {
      name: 'list_agents',
      config: { description: 'List configured agents available for evaluation.' },
      handler: async () => json(await api.listAgents()),
    },
    {
      name: 'list_models',
      config: { description: 'List configured LLM models.' },
      handler: async () => json(await api.listModels()),
    },
    {
      name: 'list_test_cases',
      config: { description: 'List evaluation test cases (with storage metadata).' },
      handler: async () => json(await api.listTestCasesWithMeta()),
    },
    {
      name: 'list_benchmarks',
      config: { description: 'List benchmarks (with storage metadata).' },
      handler: async () => json(await api.listBenchmarksWithMeta()),
    },
    {
      name: 'list_evaluators',
      config: { description: 'List evaluators (system + custom).' },
      handler: async () => json(await api.listEvaluators()),
    },

    // ── Read: single resources ──────────────────────────────────────
    {
      name: 'get_test_case',
      config: {
        description: 'Get a single test case by ID or name.',
        inputSchema: { identifier: z.string().describe('Test case ID or exact name') },
      },
      handler: async ({ identifier }) => json(await api.findTestCase(identifier)),
    },
    {
      name: 'get_benchmark',
      config: {
        description: 'Get a single benchmark (including its runs) by ID or name.',
        inputSchema: { identifier: z.string().describe('Benchmark ID or exact name') },
      },
      handler: async ({ identifier }) => json(await api.findBenchmark(identifier)),
    },
    {
      name: 'get_report',
      config: {
        description: 'Get a single evaluation report (TestCaseRun) by report ID.',
        inputSchema: { reportId: z.string().describe('Report ID, e.g. from run.results[id].reportId') },
      },
      handler: async ({ reportId }) => json(await api.getReportById(reportId)),
    },
    {
      name: 'export_benchmark',
      config: {
        description: 'Export a benchmark\'s test cases as import-compatible JSON.',
        inputSchema: { benchmarkId: z.string() },
      },
      handler: async ({ benchmarkId }) => json(await api.exportBenchmark(benchmarkId)),
    },

    // ── Read: traces ────────────────────────────────────────────────
    {
      name: 'fetch_traces',
      config: {
        description: 'Fetch OpenTelemetry spans from the configured observability cluster, filtered by trace/run/service/time/text.',
        inputSchema: {
          traceId: z.string().optional(),
          runIds: z.array(z.string()).optional(),
          sessionId: z.string().optional(),
          serviceName: z.string().optional(),
          startTime: z.string().optional().describe('ISO-8601'),
          endTime: z.string().optional().describe('ISO-8601'),
          textSearch: z.string().optional(),
          cursor: z.string().optional(),
          size: z.number().int().positive().max(1000).optional(),
        },
      },
      handler: async (args) => json(await api.fetchTraces(args)),
    },

    // ── Actions (long-running: block on SSE, return final result) ────
    {
      name: 'run_evaluation',
      config: {
        description: 'Run a single test case against an agent and return the evaluation result. Blocks until the run completes.',
        inputSchema: {
          testCaseId: z.string(),
          agentKey: z.string(),
          modelId: z.string(),
          evaluatorId: z.string().optional(),
          judgeModelId: z.string().optional(),
        },
      },
      handler: async ({ testCaseId, agentKey, modelId, evaluatorId, judgeModelId }) =>
        json(await api.runEvaluation(testCaseId, agentKey, modelId, undefined, evaluatorId, judgeModelId)),
    },
    {
      name: 'run_benchmark',
      config: {
        description: 'Execute an existing benchmark against an agent and return the completed run. Blocks until all test cases finish.',
        inputSchema: {
          benchmarkId: z.string(),
          agentKey: z.string(),
          modelId: z.string(),
          evaluatorId: z.string().optional(),
          name: z.string().optional().describe('Run label'),
        },
      },
      handler: async ({ benchmarkId, agentKey, modelId, evaluatorId, name }) =>
        json(await api.executeBenchmark(benchmarkId, {
          name: name ?? `mcp-run-${new Date().toISOString()}`,
          agentKey,
          modelId,
          ...(evaluatorId ? { evaluatorId } : {}),
        })),
    },
  ];
}

/** Register every tool on an McpServer. Shared by the command and tests. */
export function registerTools(server: McpServer, api: ApiClient): void {
  for (const tool of buildTools(api)) {
    server.registerTool(tool.name, tool.config, tool.handler as any);
  }
}

export function createMcpCommand(): Command {
  return new Command('mcp')
    .description('Run Agent Health as an MCP server (stdio) for Claude Desktop, Cursor, and other MCP agents')
    .option('-p, --port <number>', 'Backend server port (defaults to config / AH_PORT)')
    .action(async (options: { port?: string }) => {
      // stdout is the JSON-RPC channel for the stdio transport — route ALL
      // logging to stderr so server-lifecycle/ApiClient logs never corrupt it.
      console.log = (...args: unknown[]) => { console.error(...args); };

      // Heavy imports are deferred to runtime so the module stays importable
      // (e.g. by unit tests of buildTools) without pulling in the SDK or the
      // import.meta-using server lifecycle.
      const [
        { McpServer },
        { StdioServerTransport },
        { loadConfig },
        { connectorRegistry },
        { ensureServer, getCliVersion },
        { ApiClient },
      ] = await Promise.all([
        import('@modelcontextprotocol/sdk/server/mcp.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
        import('@/lib/config/index.js'),
        import('@/services/connectors/server.js'),
        import('@/cli/utils/serverLifecycle.js'),
        import('@/cli/utils/apiClient.js'),
      ]);

      const config = await loadConfig();
      for (const connector of config.connectors) {
        connectorRegistry.register(connector);
      }
      if (options.port) {
        config.server.port = parseInt(options.port, 10);
      }

      // Boot (or reuse) the local backend — same path the rest of the CLI uses.
      const serverResult = await ensureServer(config.server);
      const api = new ApiClient(serverResult.baseUrl);

      const server = new McpServer({ name: 'agent-health', version: getCliVersion() });
      registerTools(server, api);

      await server.connect(new StdioServerTransport());
      console.error(`[agent-health mcp] ready — backend ${serverResult.baseUrl}`);
    });
}
