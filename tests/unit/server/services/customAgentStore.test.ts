/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentConfig } from '@/types';

// ---------------------------------------------------------------------------
// statePaths mock (config v2) — customAgentStore now reads/writes the runtime
// state file via statePaths, not fs directly. We mock the module so tests
// control layered reads, writes, and the code-first mode gate.
// ---------------------------------------------------------------------------
jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: jest.fn(() => ({})),
  writeStateScope: jest.fn(),
  isCodeFirstMode: jest.fn(() => false),
}));

import { readLayeredState, writeStateScope, isCodeFirstMode } from '@/lib/config/statePaths';
import {
  addCustomAgent,
  removeCustomAgent,
  getCustomAgents,
  clearCustomAgents,
  loadFromDisk,
} from '@/server/services/customAgentStore';

const mockReadLayeredState = readLayeredState as jest.Mock;
const mockWriteStateScope = writeStateScope as jest.Mock;
const mockIsCodeFirstMode = isCodeFirstMode as jest.Mock;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const makeAgent = (key: string, name: string, endpoint: string): AgentConfig => ({
  key,
  name,
  endpoint,
  headers: {},
  connectorType: 'agui-streaming',
});

describe('customAgentStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadLayeredState.mockReturnValue({});
    mockWriteStateScope.mockReset();
    mockIsCodeFirstMode.mockReturnValue(false);
    clearCustomAgents();
    jest.clearAllMocks();
    mockReadLayeredState.mockReturnValue({});
    mockIsCodeFirstMode.mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // loadFromDisk — hydrate from layered runtime state
  // -----------------------------------------------------------------------

  describe('loadFromDisk', () => {
    it('hydrates the store from the runtime state file', () => {
      const agents = [makeAgent('a', 'Agent A', 'http://a.example.com')];
      mockReadLayeredState.mockReturnValue({ customAgents: agents });

      loadFromDisk();
      const result = getCustomAgents();

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('a');
      expect(result[0].isCustom).toBe(true);
    });

    it('starts empty when there is no runtime state (or code-first mode → {})', () => {
      mockReadLayeredState.mockReturnValue({});
      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });

    it('starts empty when customAgents key is missing', () => {
      mockReadLayeredState.mockReturnValue({ otherKey: 'value' });
      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });

    it('skips entries that lack a key property', () => {
      mockReadLayeredState.mockReturnValue({
        customAgents: [
          { name: 'No Key', endpoint: 'http://x' },
          makeAgent('valid', 'Valid', 'http://valid'),
        ],
      });

      loadFromDisk();
      const result = getCustomAgents();
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('valid');
    });

    it('handles a non-array customAgents value gracefully', () => {
      mockReadLayeredState.mockReturnValue({ customAgents: 'not-an-array' });
      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // saveToDisk (called by add / remove / clear)
  // -----------------------------------------------------------------------

  describe('saveToDisk', () => {
    it('writes customAgents to the project state file after addCustomAgent', () => {
      addCustomAgent(makeAgent('x', 'X', 'http://x'));

      expect(mockWriteStateScope).toHaveBeenCalledTimes(1);
      const [patch, scope] = mockWriteStateScope.mock.calls[0];
      expect(scope).toBe('project');
      expect(patch.customAgents).toHaveLength(1);
      expect(patch.customAgents[0].key).toBe('x');
    });

    it('deletes the customAgents key (undefined patch) when the last agent is removed', () => {
      addCustomAgent(makeAgent('z', 'Z', 'http://z'));
      jest.clearAllMocks();

      removeCustomAgent('z');

      expect(mockWriteStateScope).toHaveBeenCalledTimes(1);
      const [patch] = mockWriteStateScope.mock.calls[0];
      expect(patch).toEqual({ customAgents: undefined });
    });

    it('is a no-op (and warns) in code-first mode — agents are managed in the .ts', () => {
      mockIsCodeFirstMode.mockReturnValue(true);

      addCustomAgent(makeAgent('cf', 'CF', 'http://cf'));

      expect(mockWriteStateScope).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
      // Still tracked in memory for the session
      expect(getCustomAgents().find((a) => a.key === 'cf')).toBeDefined();
    });

    it('logs error but does not throw when writeStateScope fails', () => {
      mockWriteStateScope.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      expect(() => addCustomAgent(makeAgent('w', 'W', 'http://w'))).not.toThrow();
      expect(console.error).toHaveBeenCalled();
      expect(getCustomAgents().find((a) => a.key === 'w')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Public API (CRUD operations)
  // -----------------------------------------------------------------------

  describe('addCustomAgent', () => {
    it('stores an agent that can be retrieved', () => {
      addCustomAgent(makeAgent('custom-1', 'My Agent', 'http://localhost:3000'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].key).toBe('custom-1');
      expect(agents[0].name).toBe('My Agent');
      expect(agents[0].endpoint).toBe('http://localhost:3000');
    });

    it('sets isCustom to true on stored agents', () => {
      addCustomAgent(makeAgent('custom-2', 'Agent', 'http://localhost:4000'));
      expect(getCustomAgents()[0].isCustom).toBe(true);
    });

    it('overwrites agent with same key', () => {
      addCustomAgent(makeAgent('custom-1', 'Original', 'http://localhost:3000'));
      addCustomAgent(makeAgent('custom-1', 'Updated', 'http://localhost:4000'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Updated');
      expect(agents[0].endpoint).toBe('http://localhost:4000');
    });
  });

  describe('removeCustomAgent', () => {
    it('removes an existing agent and returns true', () => {
      addCustomAgent(makeAgent('custom-1', 'Agent', 'http://localhost:3000'));

      const result = removeCustomAgent('custom-1');
      expect(result).toBe(true);
      expect(getCustomAgents()).toHaveLength(0);
    });

    it('returns false for non-existent key', () => {
      expect(removeCustomAgent('nonexistent')).toBe(false);
    });
  });

  describe('getCustomAgents', () => {
    it('returns empty array when store is empty', () => {
      expect(getCustomAgents()).toEqual([]);
    });

    it('returns all stored agents', () => {
      addCustomAgent(makeAgent('a', 'Agent A', 'http://a.example.com'));
      addCustomAgent(makeAgent('b', 'Agent B', 'http://b.example.com'));
      addCustomAgent(makeAgent('c', 'Agent C', 'http://c.example.com'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.key).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('clearCustomAgents', () => {
    it('empties the store', () => {
      addCustomAgent(makeAgent('a', 'Agent A', 'http://a.example.com'));
      addCustomAgent(makeAgent('b', 'Agent B', 'http://b.example.com'));

      clearCustomAgents();
      expect(getCustomAgents()).toEqual([]);
    });

    it('is safe to call on empty store', () => {
      clearCustomAgents();
      expect(getCustomAgents()).toEqual([]);
    });
  });
});
