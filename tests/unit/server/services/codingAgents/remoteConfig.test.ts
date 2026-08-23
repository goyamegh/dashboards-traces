/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Config v2: remoteConfig reads from layered runtime state, not a JSON file.
jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: jest.fn(() => ({})),
}));

import { getRemoteServers } from '@/server/services/codingAgents/remoteConfig';
import { readLayeredState } from '@/lib/config/statePaths';

const mockReadLayeredState = readLayeredState as jest.Mock;

describe('remoteConfig', () => {
  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadLayeredState.mockReturnValue({});
  });

  describe('getRemoteServers', () => {
    it('returns empty array when there is no runtime state (or code-first → {})', () => {
      mockReadLayeredState.mockReturnValue({});
      expect(getRemoteServers()).toEqual([]);
    });

    it('returns empty array when state has no remoteServers key', () => {
      mockReadLayeredState.mockReturnValue({ agents: [] });
      expect(getRemoteServers()).toEqual([]);
    });

    it('returns servers when state has valid remoteServers', () => {
      const servers = [
        { name: 'server-1', url: 'http://localhost:4002' },
        { name: 'server-2', url: 'http://localhost:4003' },
      ];
      mockReadLayeredState.mockReturnValue({ remoteServers: servers });
      expect(getRemoteServers()).toEqual(servers);
    });

    it('filters out entries missing name', () => {
      mockReadLayeredState.mockReturnValue({
        remoteServers: [
          { url: 'http://localhost:4002' },
          { name: 'valid', url: 'http://localhost:4003' },
        ],
      });
      expect(getRemoteServers()).toEqual([{ name: 'valid', url: 'http://localhost:4003' }]);
    });

    it('filters out entries missing url', () => {
      mockReadLayeredState.mockReturnValue({
        remoteServers: [
          { name: 'no-url' },
          { name: 'valid', url: 'http://localhost:4003' },
        ],
      });
      expect(getRemoteServers()).toEqual([{ name: 'valid', url: 'http://localhost:4003' }]);
    });

    it('returns empty array when remoteServers is not an array', () => {
      mockReadLayeredState.mockReturnValue({ remoteServers: 'nope' });
      expect(getRemoteServers()).toEqual([]);
    });

    it('includes apiKey when present', () => {
      const servers = [
        { name: 'secure-server', url: 'http://localhost:4002', apiKey: 'secret-token' },
      ];
      mockReadLayeredState.mockReturnValue({ remoteServers: servers });
      expect(getRemoteServers()).toEqual(servers);
    });
  });
});
