/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type KiroWorkspaceModule = typeof import('@/server/services/codingAgents/readers/kiroWorkspace');

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function loadKiroWorkspaceModule(homeDir: string): KiroWorkspaceModule {
  jest.resetModules();
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => homeDir,
  }));
  return require('@/server/services/codingAgents/readers/kiroWorkspace') as KiroWorkspaceModule;
}

describe('getKiroWorkspace', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('reads settings, MCP servers, agents, powers, extensions, and recent commands', async () => {
    const kiroDir = path.join(homeDir, '.kiro');

    writeFixture(path.join(kiroDir, 'settings', 'cli.json'), JSON.stringify({
      defaultModel: 'claude-sonnet-4.5',
      useMcp: true,
    }));
    writeFixture(path.join(kiroDir, 'settings', 'mcp.json'), JSON.stringify({
      mcpServers: {
        repo: {
          command: 'npx',
          args: ['repo-server'],
          disabled: false,
          disabledTools: ['dangerous'],
        },
        docs: {
          command: 'uvx',
          args: [],
          disabled: true,
        },
      },
    }));
    writeFixture(path.join(kiroDir, 'agents', 'reviewer.json'), JSON.stringify({
      name: 'Reviewer',
      description: 'Reviews code changes for issues',
      mcpServers: { repo: true },
      hooks: { onStart: true },
      resources: ['guide.md', 'rubric.md'],
    }));
    writeFixture(path.join(kiroDir, 'agents', 'example-template.json'), JSON.stringify({
      name: 'Ignore me',
    }));
    writeFixture(path.join(kiroDir, 'powers', 'installed.json'), JSON.stringify({
      installedPowers: [
        { name: 'Search', registryId: 'search.registry' },
        { name: 'Review', registryId: 'review.registry' },
      ],
    }));
    fs.mkdirSync(path.join(kiroDir, 'extensions', 'publisher.review-1.2.3-linux-x64'), { recursive: true });
    fs.mkdirSync(path.join(kiroDir, 'extensions', 'plain-folder'), { recursive: true });
    writeFixture(path.join(kiroDir, '.cli_bash_history'), [
      'kiro agents list',
      'kiro powers list',
      'kiro agents list',
      'kiro workspace status',
      '',
    ].join('\n'));

    const workspace = loadKiroWorkspaceModule(homeDir);
    const data = await workspace.getKiroWorkspace();

    expect(data.settings).toEqual({
      defaultModel: 'claude-sonnet-4.5',
      useMcp: true,
    });
    expect(data.mcpServers).toEqual([
      {
        name: 'repo',
        command: 'npx',
        args: ['repo-server'],
        disabled: false,
        disabledToolCount: 1,
      },
      {
        name: 'docs',
        command: 'uvx',
        args: [],
        disabled: true,
        disabledToolCount: 0,
      },
    ]);
    expect(data.agents).toEqual([
      {
        name: 'Reviewer',
        description: 'Reviews code changes for issues',
        hasMcpServers: true,
        hasHooks: true,
        resourceCount: 2,
      },
    ]);
    expect(data.powers).toEqual([
      { name: 'Search', registryId: 'search.registry' },
      { name: 'Review', registryId: 'review.registry' },
    ]);
    expect(data.extensions).toEqual([
      {
        id: 'publisher.review',
        name: 'review',
        version: '1.2.3',
      },
    ]);
    expect(data.recentCommands).toEqual([
      'kiro workspace status',
      'kiro agents list',
      'kiro powers list',
    ]);
  });

  it('falls back to empty collections when config files are absent or invalid', async () => {
    const kiroDir = path.join(homeDir, '.kiro');
    writeFixture(path.join(kiroDir, 'settings', 'cli.json'), '{bad-json');
    writeFixture(path.join(kiroDir, 'settings', 'mcp.json'), '{bad-json');
    writeFixture(path.join(kiroDir, 'powers', 'installed.json'), '{bad-json');

    const workspace = loadKiroWorkspaceModule(homeDir);
    await expect(workspace.getKiroWorkspace()).resolves.toEqual({
      settings: {},
      mcpServers: [],
      agents: [],
      powers: [],
      extensions: [],
      recentCommands: [],
    });
  });
});
