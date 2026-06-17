/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the config-v2 resolution plane (#261 / #271).
 *
 * Uses the REAL filesystem + REAL modules (statePaths, configService) — no fs
 * mocks — to lock the two-mode behavior end to end so the original bugs cannot
 * silently return:
 *   - #261: storage/observability authored in agent-health.config.ts must be
 *     honored (not silently dropped).
 *   - config-v2: when an authored config is present (code-first) the runtime
 *     state file is ignored and the .ts wins; otherwise (ui-first) the state
 *     file is the writable source; Save writes state.json; precedence is
 *     ts > state > env.
 *
 * Runs without a backend/OpenSearch (no HTTP, no network), so it is
 * deterministic in CI on Node 18/20/22.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isCodeFirstMode,
  projectStatePath,
  readLayeredState,
} from '@/lib/config/statePaths';
// Relative path (not @/) on purpose: jest's moduleNameMapper redirects
// @/server/services/configService to a mock; this integration test needs the
// REAL implementation. The mapper doesn't catch this deep server/services path.
import {
  getStorageConfigFromFile,
  getStorageConfigFromTs,
  getConfigStatus,
  saveStorageConfig,
  setTsClusterConfig,
  __resetTsClusterConfigForTests,
} from '../../../server/services/configService';

const STORAGE = {
  endpoint: 'https://cluster.example.com',
  authType: 'sigv4' as const,
  awsRegion: 'us-east-1',
  awsService: 'es' as const,
  awsProfile: 'default',
};

let tmpRoot: string;
let originalCwd: string;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  originalCwd = process.cwd();
});

afterAll(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cfg-'));
  __resetTsClusterConfigForTests();
  // Ensure env doesn't leak a data source into these tests.
  delete process.env.OPENSEARCH_STORAGE_ENDPOINT;
});

afterEach(() => {
  process.chdir(originalCwd);
  __resetTsClusterConfigForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeStateJson(dir: string, obj: unknown): void {
  fs.mkdirSync(path.join(dir, '.agent-health'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent-health', 'state.json'), JSON.stringify(obj, null, 2));
}

describe('config-v2 resolution (real filesystem)', () => {
  describe('code-first mode (an authored agent-health.config.ts exists)', () => {
    beforeEach(() => {
      // The file only needs to EXIST for mode detection; app.ts feeds the
      // parsed values to setTsClusterConfig (simulated here).
      fs.writeFileSync(path.join(tmpRoot, 'agent-health.config.ts'), 'export default {};\n');
      process.chdir(tmpRoot);
      setTsClusterConfig({ storage: STORAGE });
    });

    it('detects code-first mode and exposes the TS cluster config', () => {
      expect(isCodeFirstMode(tmpRoot)).toBe(true);
      expect(getStorageConfigFromTs()?.endpoint).toBe(STORAGE.endpoint);
    });

    it('reports storage source = typescript', () => {
      const status = getConfigStatus();
      expect(status.storage.source).toBe('typescript');
      expect(status.storage.endpoint).toBe(STORAGE.endpoint);
    });

    it('IGNORES a runtime state file when a .ts is present (.ts wins)', () => {
      writeStateJson(tmpRoot, { storage: { endpoint: 'https://state-should-be-ignored.example.com' } });

      expect(readLayeredState(tmpRoot)).toEqual({}); // state ignored in code-first
      expect(getStorageConfigFromFile()).toBeNull(); // state getter yields nothing
      expect(getConfigStatus().storage.source).toBe('typescript');
      expect(getConfigStatus().storage.endpoint).toBe(STORAGE.endpoint);
    });

    it('refuses to persist via Save (writeState throws in code-first)', () => {
      expect(() => saveStorageConfig({ endpoint: 'https://nope.example.com' })).toThrow(/code-first/i);
      // and nothing was written
      expect(fs.existsSync(projectStatePath(tmpRoot))).toBe(false);
    });
  });

  describe('ui-first mode (no authored config)', () => {
    beforeEach(() => {
      process.chdir(tmpRoot);
    });

    it('reads storage from .agent-health/state.json (source = file)', () => {
      writeStateJson(tmpRoot, { storage: STORAGE });

      expect(isCodeFirstMode(tmpRoot)).toBe(false);
      expect(getStorageConfigFromFile()?.endpoint).toBe(STORAGE.endpoint);
      expect(getConfigStatus().storage.source).toBe('file');
    });

    it('Save persists to the project .agent-health/state.json', () => {
      saveStorageConfig({ ...STORAGE, endpoint: 'https://saved.example.com' });

      const onDisk = JSON.parse(fs.readFileSync(projectStatePath(tmpRoot), 'utf-8'));
      expect(onDisk.storage.endpoint).toBe('https://saved.example.com');
      expect(getConfigStatus().storage.source).toBe('file');
    });

    it('reports source = none when nothing is configured', () => {
      expect(getConfigStatus().storage.source).toBe('none');
      expect(getStorageConfigFromFile()).toBeNull();
    });
  });
});
