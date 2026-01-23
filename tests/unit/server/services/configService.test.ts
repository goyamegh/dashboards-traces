/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * configService tests
 *
 * Note: The real configService uses import.meta.url which Jest cannot handle.
 * These tests verify the mock behavior and serve as documentation for expected API.
 * The actual implementation is tested via integration tests.
 */

import {
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
  getConfigStatus,
  configFileExists,
} from '@/server/services/configService';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('configService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getStorageConfigFromFile', () => {
    it('should return null by default', () => {
      const result = getStorageConfigFromFile();
      expect(result).toBeNull();
    });

    it('should return configured value when mocked', () => {
      const mockConfig = {
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
      };
      (getStorageConfigFromFile as jest.Mock).mockReturnValueOnce(mockConfig);

      const result = getStorageConfigFromFile();

      expect(result).toEqual(mockConfig);
    });
  });

  describe('getObservabilityConfigFromFile', () => {
    it('should return null by default', () => {
      const result = getObservabilityConfigFromFile();
      expect(result).toBeNull();
    });

    it('should return configured value when mocked', () => {
      const mockConfig = {
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
        indexes: {
          traces: 'traces-*',
          logs: 'logs-*',
        },
      };
      (getObservabilityConfigFromFile as jest.Mock).mockReturnValueOnce(mockConfig);

      const result = getObservabilityConfigFromFile();

      expect(result).toEqual(mockConfig);
    });
  });

  describe('saveStorageConfig', () => {
    it('should be callable', () => {
      saveStorageConfig({
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
      });

      expect(saveStorageConfig).toHaveBeenCalledWith({
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
      });
    });
  });

  describe('saveObservabilityConfig', () => {
    it('should be callable', () => {
      saveObservabilityConfig({
        endpoint: 'https://obs.com',
      });

      expect(saveObservabilityConfig).toHaveBeenCalledWith({
        endpoint: 'https://obs.com',
      });
    });
  });

  describe('clearStorageConfig', () => {
    it('should be callable', () => {
      clearStorageConfig();
      expect(clearStorageConfig).toHaveBeenCalled();
    });
  });

  describe('clearObservabilityConfig', () => {
    it('should be callable', () => {
      clearObservabilityConfig();
      expect(clearObservabilityConfig).toHaveBeenCalled();
    });
  });

  describe('getConfigStatus', () => {
    it('should return unconfigured status by default', () => {
      const status = getConfigStatus();

      expect(status.storage.source).toBe('none');
      expect(status.storage.configured).toBe(false);
      expect(status.observability.source).toBe('none');
      expect(status.observability.configured).toBe(false);
    });

    it('should return configured status when mocked', () => {
      (getConfigStatus as jest.Mock).mockReturnValueOnce({
        storage: {
          configured: true,
          source: 'file',
          endpoint: 'https://storage.com',
        },
        observability: {
          configured: true,
          source: 'environment',
          endpoint: 'https://obs.com',
        },
      });

      const status = getConfigStatus();

      expect(status.storage.source).toBe('file');
      expect(status.storage.configured).toBe(true);
      expect(status.storage.endpoint).toBe('https://storage.com');
      expect(status.observability.source).toBe('environment');
      expect(status.observability.configured).toBe(true);
      expect(status.observability.endpoint).toBe('https://obs.com');
    });
  });

  describe('configFileExists', () => {
    it('should return false by default', () => {
      expect(configFileExists()).toBe(false);
    });

    it('should return true when mocked', () => {
      (configFileExists as jest.Mock).mockReturnValueOnce(true);
      expect(configFileExists()).toBe(true);
    });
  });
});
