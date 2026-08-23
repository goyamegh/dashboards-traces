/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  resolveAgentPath,
  isAgentPathConfigured,
  hasAgentPathEnv,
  _resetAgentPathWarningForTests,
} from '@/server/services/agentPath/path';

describe('agentPath/path', () => {
  let tmpRoot: string;
  const originalEnv = process.env.AH_AGENT_PATH;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ah-path-test-'));
    delete process.env.AH_AGENT_PATH;
    _resetAgentPathWarningForTests();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.AH_AGENT_PATH;
    else process.env.AH_AGENT_PATH = originalEnv;
  });

  describe('resolveAgentPath', () => {
    it('returns null when AH_AGENT_PATH is unset', () => {
      expect(resolveAgentPath()).toBeNull();
    });

    it('returns null for empty / whitespace AH_AGENT_PATH', () => {
      process.env.AH_AGENT_PATH = '   ';
      expect(resolveAgentPath()).toBeNull();
    });

    it('returns absolute path when AH_AGENT_PATH points to an existing dir', () => {
      process.env.AH_AGENT_PATH = tmpRoot;
      expect(resolveAgentPath()).toBe(tmpRoot);
    });

    it('returns null when path does not exist', () => {
      process.env.AH_AGENT_PATH = join(tmpRoot, 'no-such-dir');
      expect(resolveAgentPath()).toBeNull();
    });

    it('returns null when path is a file (not a directory)', () => {
      const file = join(tmpRoot, 'a.txt');
      writeFileSync(file, 'hi');
      process.env.AH_AGENT_PATH = file;
      expect(resolveAgentPath()).toBeNull();
    });
  });

  describe('isAgentPathConfigured', () => {
    it('matches resolveAgentPath truthiness', () => {
      expect(isAgentPathConfigured()).toBe(false);
      process.env.AH_AGENT_PATH = tmpRoot;
      expect(isAgentPathConfigured()).toBe(true);
    });
  });

  describe('hasAgentPathEnv', () => {
    it('returns true even before the dir-check, as long as path exists', () => {
      process.env.AH_AGENT_PATH = tmpRoot;
      expect(hasAgentPathEnv()).toBe(true);
    });
    it('returns false when env is unset', () => {
      expect(hasAgentPathEnv()).toBe(false);
    });
  });
});
