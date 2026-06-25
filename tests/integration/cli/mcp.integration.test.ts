/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the MCP server.
 *
 * Exercises the real MCP protocol round-trip (Client ↔ McpServer over the
 * SDK's in-memory transport) wired to a real ApiClient hitting the live
 * backend — the same path Claude Desktop / Cursor would drive over stdio,
 * minus the subprocess. Uses only read-only tools, so nothing to clean up.
 *
 * Requires the backend running (npm run dev:server); skips gracefully if not.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '@/cli/commands/mcp';
import { ApiClient } from '@/cli/utils/apiClient';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const TEST_TIMEOUT = 30000;

const checkBackend = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
};

/** Extract the text payload from a CallTool result. */
function text(result: any): string {
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content[0].type).toBe('text');
  return result.content[0].text;
}

describe('MCP server integration', () => {
  let backendAvailable = false;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping MCP integration tests');
      return;
    }

    server = new McpServer({ name: 'agent-health', version: 'test' });
    registerTools(server, new ApiClient(BASE_URL));

    client = new Client({ name: 'test-client', version: 'test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
  });

  it('advertises the agent-health tool set via tools/list', async () => {
    if (!backendAvailable) return;
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'list_agents', 'list_benchmarks', 'list_test_cases', 'list_models', 'list_evaluators',
        'get_test_case', 'get_benchmark', 'get_report', 'export_benchmark', 'fetch_traces',
        'run_evaluation', 'run_benchmark',
      ])
    );
    // Every tool carries a description for the agent to read.
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description!.length).toBeGreaterThan(0);
    }
  }, TEST_TIMEOUT);

  it('list_benchmarks returns storage-shaped JSON from the real API', async () => {
    if (!backendAvailable) return;
    const result = await client.callTool({ name: 'list_benchmarks', arguments: {} });
    const payload = JSON.parse(text(result));
    expect(payload).toHaveProperty('data');
    expect(payload).toHaveProperty('total');
    expect(payload).toHaveProperty('meta');
    expect(Array.isArray(payload.data)).toBe(true);
  }, TEST_TIMEOUT);

  it('list_agents returns an array from the real API', async () => {
    if (!backendAvailable) return;
    const result = await client.callTool({ name: 'list_agents', arguments: {} });
    expect(Array.isArray(JSON.parse(text(result)))).toBe(true);
  }, TEST_TIMEOUT);

  it('get_report with an unknown id returns null (not an error)', async () => {
    if (!backendAvailable) return;
    const result = await client.callTool({ name: 'get_report', arguments: { reportId: 'does-not-exist-xyz' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toBeNull();
  }, TEST_TIMEOUT);

  it('reports an error result when a required argument is missing', async () => {
    if (!backendAvailable) return;
    // get_report requires reportId — the SDK should reject the malformed call.
    const result: any = await client.callTool({ name: 'get_report', arguments: {} }).catch((e) => ({ thrown: e }));
    // Either the call rejects (validation) or returns an isError result.
    expect(result.thrown || result.isError).toBeTruthy();
  }, TEST_TIMEOUT);
});
