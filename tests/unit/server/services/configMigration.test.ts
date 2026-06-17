/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config v2 migration tests (#271): agent-health.yaml AND legacy
 * agent-health.config.json → .agent-health/state.json.
 */

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn().mockReturnValue('');
const mockWriteFileSync = jest.fn();
const mockRenameSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a),
  readFileSync: (...a: any[]) => mockReadFileSync(...a),
  writeFileSync: (...a: any[]) => mockWriteFileSync(...a),
  renameSync: (...a: any[]) => mockRenameSync(...a),
  mkdirSync: (...a: any[]) => mockMkdirSync(...a),
}));

jest.mock('path', () => ({ join: (...segments: string[]) => segments.join('/') }));

const mockYamlLoad = jest.fn();
jest.mock('js-yaml', () => ({ load: (...a: any[]) => mockYamlLoad(...a) }));

const mockIsCodeFirstMode = jest.fn(() => false);
jest.mock('@/lib/config/statePaths', () => ({
  projectStateDir: jest.fn(() => '/cwd/.agent-health'),
  projectStatePath: jest.fn(() => '/cwd/.agent-health/state.json'),
  isCodeFirstMode: () => mockIsCodeFirstMode(),
  LEGACY_JSON_FILENAME: 'agent-health.config.json',
}));

import { migrateYamlToJsonIfNeeded } from '@/server/services/configMigration';

const STATE_PATH = '/cwd/.agent-health/state.json';

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

/** existsSync by path suffix. */
function setupExists(opts: { yaml?: boolean; yamlBackup?: boolean; legacyJson?: boolean; jsonBackup?: boolean; state?: boolean }) {
  mockExistsSync.mockImplementation((p: string) => {
    if (p.endsWith('agent-health.yaml.backup')) return opts.yamlBackup ?? false;
    if (p.endsWith('agent-health.yaml')) return opts.yaml ?? false;
    if (p.endsWith('agent-health.config.json.backup')) return opts.jsonBackup ?? false;
    if (p.endsWith('agent-health.config.json')) return opts.legacyJson ?? false;
    if (p === STATE_PATH) return opts.state ?? false;
    return false;
  });
}

/** Last write to the state file. */
function lastStateWrite(): any {
  const call = [...mockWriteFileSync.mock.calls].reverse().find((c) => c[0] === STATE_PATH);
  if (!call) throw new Error('state.json was not written');
  return JSON.parse(call[1]);
}

describe('configMigration (config v2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    mockMkdirSync.mockReset();
    mockYamlLoad.mockReset();
    mockIsCodeFirstMode.mockReturnValue(false);
  });

  describe('no-op conditions', () => {
    it('does nothing when neither yaml nor legacy json exist', async () => {
      setupExists({});
      await migrateYamlToJsonIfNeeded();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('skips yaml when its backup already exists', async () => {
      setupExists({ yaml: true, yamlBackup: true });
      await migrateYamlToJsonIfNeeded();
      expect(mockYamlLoad).not.toHaveBeenCalled();
    });

    it('skips legacy json when its backup already exists', async () => {
      setupExists({ legacyJson: true, jsonBackup: true });
      await migrateYamlToJsonIfNeeded();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });
  });

  describe('yaml → state.json', () => {
    it('migrates storage + observability and backs up the yaml', async () => {
      setupExists({ yaml: true });
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        storage: { endpoint: 'https://s.com' },
        observability: { endpoint: 'https://o.com' },
      });

      await migrateYamlToJsonIfNeeded();

      const state = lastStateWrite();
      expect(state.storage).toEqual({ endpoint: 'https://s.com' });
      expect(state.observability).toEqual({ endpoint: 'https://o.com' });
      expect(mockMkdirSync).toHaveBeenCalledWith('/cwd/.agent-health', { recursive: true });
      const [src, dest] = mockRenameSync.mock.calls[0];
      expect(src).toContain('agent-health.yaml');
      expect(dest).toContain('agent-health.yaml.backup');
    });

    it('warns and does not write when yaml is empty/invalid', async () => {
      setupExists({ yaml: true });
      mockYamlLoad.mockReturnValue(null);
      await migrateYamlToJsonIfNeeded();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('empty or invalid'));
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('legacy agent-health.config.json → state.json', () => {
    it('migrates all state keys and backs up the legacy json', async () => {
      setupExists({ legacyJson: true });
      const legacy = {
        storage: { endpoint: 'https://s.com' },
        observability: { endpoint: 'https://o.com' },
        customAgents: [{ key: 'a' }],
        debug: true,
        remoteServers: [{ name: 'r', url: 'http://r' }],
      };
      mockReadFileSync.mockImplementation((p: string) =>
        p.endsWith('agent-health.config.json') ? JSON.stringify(legacy) : '');

      await migrateYamlToJsonIfNeeded();

      const state = lastStateWrite();
      expect(state.storage).toEqual(legacy.storage);
      expect(state.observability).toEqual(legacy.observability);
      expect(state.customAgents).toEqual(legacy.customAgents);
      expect(state.debug).toBe(true);
      expect(state.remoteServers).toEqual(legacy.remoteServers);
      const [src, dest] = mockRenameSync.mock.calls[0];
      expect(src).toContain('agent-health.config.json');
      expect(dest).toContain('agent-health.config.json.backup');
    });

    it('warns (clusters ignored) when a .ts is also present (code-first)', async () => {
      mockIsCodeFirstMode.mockReturnValue(true);
      setupExists({ legacyJson: true });
      mockReadFileSync.mockImplementation((p: string) =>
        p.endsWith('agent-health.config.json') ? JSON.stringify({ storage: { endpoint: 'https://s.com' } }) : '');

      await migrateYamlToJsonIfNeeded();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('IGNORED'));
    });

    it('skips a corrupt legacy json without renaming', async () => {
      setupExists({ legacyJson: true });
      mockReadFileSync.mockImplementation((p: string) =>
        p.endsWith('agent-health.config.json') ? 'NOT JSON {{{' : '');

      await migrateYamlToJsonIfNeeded();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable/corrupt'));
      expect(mockRenameSync).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('does not throw when write fails', async () => {
      setupExists({ yaml: true });
      mockYamlLoad.mockReturnValue({ storage: { endpoint: 'https://s.com' } });
      mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES'); });
      await expect(migrateYamlToJsonIfNeeded()).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });
  });
});
