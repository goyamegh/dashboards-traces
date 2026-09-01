/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `list` CLI command's `images`/`img` resource
 * (cli/commands/list.ts's listImages()) — the resource type added alongside
 * content-addressed benchmark images.
 */

jest.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalkMock = { bold: identity, gray: identity, cyan: identity, red: identity };
  return { default: chalkMock, ...chalkMock };
});

jest.mock('cli-table3', () => {
  return jest.fn().mockImplementation(() => ({
    push: jest.fn(),
    toString: () => '[table]',
  }));
});

jest.mock('@/lib/config/index', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { register: jest.fn() },
}));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: jest.fn(),
  createServerCleanup: jest.fn(),
}));

jest.mock('@/cli/utils/apiClient', () => ({
  ApiClient: jest.fn(),
}));

import { createListCommand } from '@/cli/commands/list';
import { loadConfig } from '@/lib/config/index';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle';
import { ApiClient } from '@/cli/utils/apiClient';

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockEnsureServer = ensureServer as jest.MockedFunction<typeof ensureServer>;
const mockCreateServerCleanup = createServerCleanup as jest.MockedFunction<typeof createServerCleanup>;
const MockApiClient = ApiClient as unknown as jest.Mock;

const sampleImages = [
  {
    digest: 'abcdef1234567890abcdef',
    tags: ['nightly', 'v1'],
    testCaseCount: 5,
    evalConditions: { judgeModelId: 'claude-3', evaluatorId: 'default' },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    digest: 'zzzz999999999999999999',
    tags: [],
    testCaseCount: 2,
    evalConditions: {},
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

describe('createListCommand — images resource', () => {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  let listImagesMock: jest.Mock;
  let cleanupMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exit = jest.fn() as any;
    console.log = jest.fn();
    console.error = jest.fn();

    mockLoadConfig.mockResolvedValue({ connectors: [], server: {} } as any);
    mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4001' } as any);
    cleanupMock = jest.fn();
    mockCreateServerCleanup.mockReturnValue(cleanupMock);

    listImagesMock = jest.fn().mockResolvedValue(sampleImages);
    MockApiClient.mockImplementation(() => ({ listImages: listImagesMock }));
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  it('registers "images"/"img" as valid resource aliases in the argument description', () => {
    const cmd = createListCommand();
    expect(cmd.registeredArguments[0].description).toContain('images');
  });

  it('"images" resource: fetches and renders a table by default', async () => {
    const cmd = createListCommand();
    await cmd.parseAsync(['node', 'list', 'images']);

    expect(listImagesMock).toHaveBeenCalled();
    const output = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Benchmark Images');
    expect(output).toContain('Total: 2 images');
    expect(cleanupMock).toHaveBeenCalled();
  });

  it('"img" alias behaves the same as "images"', async () => {
    const cmd = createListCommand();
    await cmd.parseAsync(['node', 'list', 'img']);
    expect(listImagesMock).toHaveBeenCalled();
  });

  it('renders JSON output with --output json', async () => {
    const cmd = createListCommand();
    await cmd.parseAsync(['node', 'list', 'images', '--output', 'json']);

    const jsonCall = (console.log as jest.Mock).mock.calls.find((c) => {
      try { JSON.parse(c[0]); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.total).toBe(2);
    expect(parsed.images).toHaveLength(2);
  });

  it('renders markdown output with --output markdown', async () => {
    const cmd = createListCommand();
    await cmd.parseAsync(['node', 'list', 'images', '--output', 'markdown']);

    const output = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('|');
    expect(output).toContain('Digest');
  });

  it('prints an error and exits 1 when the API call fails, but still cleans up', async () => {
    listImagesMock.mockRejectedValue(new Error('server unreachable'));

    const cmd = createListCommand();
    await cmd.parseAsync(['node', 'list', 'images']);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('server unreachable'));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(cleanupMock).toHaveBeenCalled();
  });
});
