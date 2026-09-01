/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type ClaudeWorkspaceModule = typeof import('@/server/services/codingAgents/readers/claudeCodeWorkspace');

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function loadClaudeWorkspaceModule(homeDir: string): ClaudeWorkspaceModule {
  jest.resetModules();
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => homeDir,
  }));
  return require('@/server/services/codingAgents/readers/claudeCodeWorkspace') as ClaudeWorkspaceModule;
}

describe('claudeCodeWorkspace reader helpers', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('reads memory files and only allows updates under project memory directories', async () => {
    const projectMemoryDir = path.join(homeDir, '.claude', 'projects', 'team-app', 'memory');
    const memoryIndexPath = path.join(projectMemoryDir, 'MEMORY.md');
    const guidancePath = path.join(projectMemoryDir, 'guidance.md');

    writeFixture(memoryIndexPath, [
      '---',
      'name: Project memory',
      'description: Shared context',
      'type: index',
      '---',
      '# Team app memory',
      'Keep this content intact.',
      '',
    ].join('\n'));
    writeFixture(guidancePath, [
      '---',
      'name: Guidance',
      'description: Team conventions',
      'type: note',
      '---',
      'Use strict review checks.',
      '',
    ].join('\n'));

    const workspace = loadClaudeWorkspaceModule(homeDir);
    const memories = await workspace.getMemoryFiles();

    expect(memories.projects).toHaveLength(1);
    expect(memories.projects[0]).toMatchObject({
      slug: 'team-app',
      projectPath: 'team/app',
    });
    expect(memories.projects[0].memories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Project memory',
        description: 'Shared context',
        type: 'index',
        content: expect.stringContaining('# Team app memory'),
      }),
      expect.objectContaining({
        name: 'Guidance',
        description: 'Team conventions',
        type: 'note',
        content: 'Use strict review checks.\n',
      }),
    ]));

    await expect(workspace.updateMemoryFile(guidancePath, 'Updated guidance')).resolves.toBe(true);
    expect(fs.readFileSync(guidancePath, 'utf-8')).toBe('Updated guidance');

    await expect(
      workspace.updateMemoryFile(path.join(homeDir, '.claude', 'settings.json'), 'blocked')
    ).resolves.toBe(false);
  });

  it('reads plans and tasks, skipping malformed or incomplete task files', async () => {
    const plansDir = path.join(homeDir, '.claude', 'plans');
    const tasksDir = path.join(homeDir, '.claude', 'tasks', 'backlog');

    const olderPlan = path.join(plansDir, 'older.md');
    const newerPlan = path.join(plansDir, 'newer.md');
    writeFixture(olderPlan, 'Older plan');
    writeFixture(newerPlan, 'Newer plan');
    const oldTime = new Date('2024-01-01T00:00:00.000Z');
    const newTime = new Date('2024-01-02T00:00:00.000Z');
    fs.utimesSync(olderPlan, oldTime, oldTime);
    fs.utimesSync(newerPlan, newTime, newTime);

    writeFixture(path.join(tasksDir, 'valid.json'), JSON.stringify({
      id: 'task-1',
      subject: 'Ship tests',
      description: 'Write coverage-focused tests',
      status: 'in_progress',
      blocks: ['task-2'],
      blockedBy: ['task-0'],
      activeForm: 'Shipping tests',
      owner: 'codex',
    }));
    writeFixture(path.join(tasksDir, 'defaulted.json'), JSON.stringify({
      id: 'task-2',
      subject: 'Follow-up',
    }));
    writeFixture(path.join(tasksDir, 'invalid.json'), '{not-json');
    writeFixture(path.join(tasksDir, 'missing-subject.json'), JSON.stringify({
      id: 'task-3',
    }));

    const workspace = loadClaudeWorkspaceModule(homeDir);

    const plans = await workspace.getPlans();
    expect(plans.map(plan => plan.name)).toEqual(['newer', 'older']);
    expect(plans[0].modifiedAt).toBe(newTime.toISOString());

    const tasks = await workspace.getTasks();
    expect(tasks.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      {
        id: 'task-1',
        subject: 'Ship tests',
        description: 'Write coverage-focused tests',
        status: 'in_progress',
        blocks: ['task-2'],
        blockedBy: ['task-0'],
        activeForm: 'Shipping tests',
        owner: 'codex',
      },
      {
        id: 'task-2',
        subject: 'Follow-up',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        activeForm: undefined,
        owner: undefined,
      },
    ]);
  });

  it('reads settings, plugin metadata, extracted skills, and active sessions', async () => {
    const claudeDir = path.join(homeDir, '.claude');
    const pluginInstallPath = path.join(homeDir, 'plugins-cache', 'workflow-plugin');
    const projectsDir = path.join(claudeDir, 'projects');
    const recentProject = path.join(projectsDir, 'active-project');
    const olderProject = path.join(projectsDir, 'stale-project');
    const recentSession = path.join(recentProject, 'recent.jsonl');
    const olderSession = path.join(olderProject, 'old.jsonl');

    writeFixture(path.join(claudeDir, 'settings.json'), JSON.stringify({
      theme: 'dark',
      telemetry: false,
    }));
    writeFixture(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: {
        workflow: [{
          scope: 'user',
          version: '1.2.3',
          installedAt: '2024-02-01T00:00:00.000Z',
          installPath: pluginInstallPath,
        }],
      },
    }));
    writeFixture(path.join(pluginInstallPath, 'skills', 'triage', 'SKILL.md'), [
      '# Triage',
      '',
      'Investigates failures quickly.',
      'More detail later.',
      '',
    ].join('\n'));

    writeFixture(recentSession, [
      JSON.stringify({ type: 'user', message: { content: 'Ping' } }),
      JSON.stringify({ type: 'assistant', message: { content: [], model: 'claude-opus-4-6' } }),
      '',
    ].join('\n'));
    writeFixture(olderSession, [
      JSON.stringify({ type: 'assistant', message: { content: [], model: 'claude-haiku-4-5' } }),
      '',
    ].join('\n'));

    const now = new Date('2024-04-01T12:00:00.000Z').getTime();
    const recentMtime = new Date(now - (10 * 60 * 1000));
    const oldMtime = new Date(now - (2 * 60 * 60 * 1000));
    fs.utimesSync(recentSession, recentMtime, recentMtime);
    fs.utimesSync(olderSession, oldMtime, oldMtime);

    jest.spyOn(Date, 'now').mockReturnValue(now);

    const workspace = loadClaudeWorkspaceModule(homeDir);
    const settings = await workspace.getSettings();
    expect(settings.settings).toEqual({ theme: 'dark', telemetry: false });
    expect(settings.plugins).toEqual([
      {
        name: 'workflow',
        scope: 'user',
        version: '1.2.3',
        installedAt: '2024-02-01T00:00:00.000Z',
      },
    ]);
    expect(settings.skills).toEqual([
      {
        name: 'triage',
        description: 'Investigates failures quickly.',
      },
    ]);
    expect(settings.storage_bytes).toBeGreaterThan(0);

    const activeSessions = await workspace.getActiveSessions();
    expect(activeSessions).toEqual([
      {
        session_id: 'recent',
        project_path: 'active/project',
        project_slug: 'active-project',
        last_activity: recentMtime.toISOString(),
        last_activity_ago: '10m ago',
        model: 'claude-opus-4-6',
      },
    ]);
  });

  it('returns empty workspace data when optional files are absent', async () => {
    const workspace = loadClaudeWorkspaceModule(homeDir);

    await expect(workspace.getMemoryFiles()).resolves.toEqual({ projects: [] });
    await expect(workspace.getPlans()).resolves.toEqual([]);
    await expect(workspace.getTasks()).resolves.toEqual([]);
    await expect(workspace.getSettings()).resolves.toEqual({
      settings: {},
      skills: [],
      plugins: [],
      storage_bytes: 0,
    });
    await expect(workspace.getActiveSessions()).resolves.toEqual([]);
  });
});
