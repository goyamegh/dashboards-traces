/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for configService - avoids import.meta.url issues in Jest
 *
 * All functions are jest.fn() so tests can configure return values.
 */

export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: 'file' | 'typescript' | 'environment' | 'none';
    endpoint?: string;
    username?: string;
    hasPassword?: boolean;
  };
  observability: {
    configured: boolean;
    source: 'file' | 'typescript' | 'environment' | 'none';
    endpoint?: string;
    username?: string;
    hasPassword?: boolean;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

export const getStorageConfigFromFile = jest.fn().mockReturnValue(null);

export const saveStorageConfig = jest.fn();

export const clearStorageConfig = jest.fn();

export const getObservabilityConfigFromFile = jest.fn().mockReturnValue(null);

// TypeScript config bridge (agent-health.config.ts -> server). Mocked as
// jest.fn() so tests can configure return values per case.
export const setTsClusterConfig = jest.fn();
export const getStorageConfigFromTs = jest.fn().mockReturnValue(null);
export const getObservabilityConfigFromTs = jest.fn().mockReturnValue(null);
export const __resetTsClusterConfigForTests = jest.fn();

export const saveObservabilityConfig = jest.fn();

export const clearObservabilityConfig = jest.fn();

export const getConfigStatus = jest.fn().mockReturnValue({
  storage: {
    configured: false,
    source: 'none',
  },
  observability: {
    configured: false,
    source: 'none',
  },
});

export const configFileExists = jest.fn().mockReturnValue(false);
