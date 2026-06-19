/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock opensearchClientFactory
const mockConfigToCacheKey = jest.fn().mockReturnValue('basic|https://localhost:9200|abc123');
const mockCreateClient = jest.fn();

jest.mock('@/server/services/opensearchClientFactory', () => ({
  createOpenSearchClient: mockCreateClient,
  configToCacheKey: mockConfigToCacheKey,
}));

// Mock adapters
const mockSetStorageModule = jest.fn();
const mockSetStorageError = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  setStorageModule: mockSetStorageModule,
  setStorageError: mockSetStorageError,
  FileStorageModule: jest.fn().mockImplementation(() => ({ type: 'file' })),
  FileSessionMetadataOperations: jest.fn().mockImplementation(() => ({ type: 'file-session-metadata' })),
  OpenSearchStorageModule: jest.fn().mockImplementation(() => ({ type: 'opensearch' })),
}));

// Mock indexInitializer
const mockEnsureIndexesWithValidation = jest.fn();
jest.mock('@/server/services/indexInitializer', () => ({
  ensureIndexesWithValidation: mockEnsureIndexesWithValidation,
}));

import { initializeStorageFromConfig } from '@/server/services/storageInitializer';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('initializeStorageFromConfig', () => {
  const mockClient = {
    cluster: { health: jest.fn() },
    close: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockReturnValue(mockClient);
    mockClient.cluster.health.mockResolvedValue({ body: { status: 'green' } });
    mockClient.close.mockResolvedValue(undefined);
    mockEnsureIndexesWithValidation.mockResolvedValue({
      indexResults: { 'evals_test_cases': { status: 'exists' } },
      validationResults: [],
    });
  });

  it('should switch to file storage when config is null', async () => {
    const state = await initializeStorageFromConfig(null);

    expect(state.backend).toBe('file');
    expect(state.configKey).toBeNull();
    expect(state.error).toBeNull();
    expect(mockSetStorageModule).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file' }),
      expect.objectContaining({ backend: 'file' })
    );
  });

  it('should switch to opensearch when config is reachable', async () => {
    const config = { endpoint: 'https://localhost:9200', username: 'admin', password: 'admin' };

    const state = await initializeStorageFromConfig(config);

    expect(state.backend).toBe('opensearch');
    expect(state.configKey).toBe('basic|https://localhost:9200|abc123');
    expect(state.error).toBeNull();
    expect(state.configuredEndpoint).toBe('https://localhost:9200');
    expect(mockSetStorageModule).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'opensearch' }),
      expect.objectContaining({ backend: 'opensearch' })
    );
  });

  it('should set error state when opensearch is unreachable (not file fallback)', async () => {
    mockClient.cluster.health.mockRejectedValue(new Error('Connection refused'));
    const config = { endpoint: 'https://bad-host:9200' };

    const state = await initializeStorageFromConfig(config);

    expect(state.backend).toBe('error');
    expect(state.error).toBe('Connection refused');
    expect(state.configuredEndpoint).toBe('https://bad-host:9200');
    expect(mockSetStorageError).toHaveBeenCalledWith(
      'Connection refused',
      expect.any(String),
      'https://bad-host:9200'
    );
    // Should NOT have called setStorageModule with opensearch or file
    expect(mockSetStorageModule).not.toHaveBeenCalled();
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('should run index validation when option is set', async () => {
    const config = { endpoint: 'https://localhost:9200' };

    await initializeStorageFromConfig(config, { runIndexValidation: true });

    expect(mockEnsureIndexesWithValidation).toHaveBeenCalledWith(
      mockClient,
      expect.any(Function)
    );
  });

  it('should not run index validation by default', async () => {
    const config = { endpoint: 'https://localhost:9200' };

    await initializeStorageFromConfig(config);

    expect(mockEnsureIndexesWithValidation).not.toHaveBeenCalled();
  });

  it('should close client on connection failure', async () => {
    mockClient.cluster.health.mockRejectedValue(new Error('timeout'));
    const config = { endpoint: 'https://unreachable:9200' };

    await initializeStorageFromConfig(config);

    expect(mockClient.close).toHaveBeenCalled();
  });

  it('returns a controlled error state (does NOT throw) when client creation throws, e.g. invalid authType', async () => {
    // resolveAuthType throws for an unrecognized authType; createOpenSearchClient
    // is now inside the try, so this must become { backend: 'error' } rather than
    // crashing server startup.
    mockCreateClient.mockImplementation(() => {
      throw new Error("Invalid storage/observability authType 'aws'. Expected 'sigv4', 'basic', or 'none' (use 'sigv4' for AWS OpenSearch).");
    });
    const config = { endpoint: 'https://x', authType: 'aws' } as any;

    let state: any;
    await expect(
      (async () => { state = await initializeStorageFromConfig(config); })()
    ).resolves.not.toThrow();

    expect(state.backend).toBe('error');
    expect(state.error).toMatch(/Invalid .*authType 'aws'/);
    expect(mockSetStorageError).toHaveBeenCalled();
    // never swapped the module to a broken OpenSearch module
    expect(mockSetStorageModule).not.toHaveBeenCalled();
  });
});
