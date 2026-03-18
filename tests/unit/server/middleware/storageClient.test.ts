/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for storage client middleware
 *
 * Tests the middleware functions in isolation:
 * - storageClientMiddleware
 * - isStorageAvailable
 * - requireStorageClient
 * - getStorageClient
 */

import { Request, Response, NextFunction } from 'express';

// Mock the dataSourceConfig before importing storageClient
const mockResolveStorageConfig = jest.fn();
jest.mock('@/server/middleware/dataSourceConfig', () => ({
  resolveStorageConfig: mockResolveStorageConfig,
}));

// Mock the OpenSearch client
const mockClientClose = jest.fn();
jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    close: mockClientClose,
  })),
}));

// Mock the client factory - return a new mock client each call so cache tests work
let mockClientCallCount = 0;
jest.mock('@/server/services/opensearchClientFactory', () => ({
  createOpenSearchClient: jest.fn().mockImplementation(() => ({
    close: mockClientClose,
    _id: ++mockClientCallCount,
  })),
  configToCacheKey: jest.fn().mockImplementation((config: any) =>
    `${config.authType || 'basic'}|${config.endpoint}|${config.username || ''}|${config.password || ''}`
  ),
}));

// Mock adapters getStorageState
const mockGetStorageState = jest.fn().mockReturnValue({
  backend: 'file',
  configKey: null,
  error: null,
  configuredEndpoint: null,
});
jest.mock('@/server/adapters/index', () => ({
  getStorageState: mockGetStorageState,
}));

// Mock storageInitializer
const mockInitializeStorageFromConfig = jest.fn().mockResolvedValue({
  backend: 'opensearch',
  configKey: 'basic|https://new:9200||',
  error: null,
  configuredEndpoint: 'https://new:9200',
});
jest.mock('@/server/services/storageInitializer', () => ({
  initializeStorageFromConfig: mockInitializeStorageFromConfig,
}));

// Import after mocks are set up
import {
  storageClientMiddleware,
  isStorageAvailable,
  requireStorageClient,
  getStorageClient,
  INDEXES,
  _resetDriftState,
} from '@/server/middleware/storageClient';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Helper to create mock request/response
function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    storageClient: null,
    storageConfig: null,
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response {
  return {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function createMockNext(): NextFunction {
  return jest.fn();
}

describe('storageClientMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should attach storageClient when config is resolved', () => {
    const mockConfig = {
      endpoint: 'https://localhost:9200',
      username: 'admin',
      password: 'admin',
    };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(req.storageClient).toBeDefined();
    expect(req.storageClient).not.toBeNull();
    expect(req.storageConfig).toEqual(mockConfig);
    expect(next).toHaveBeenCalled();
  });

  it('should set storageClient to null when config is not resolved', () => {
    mockResolveStorageConfig.mockReturnValue(null);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(req.storageClient).toBeNull();
    expect(req.storageConfig).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('should always call next', () => {
    mockResolveStorageConfig.mockReturnValue(null);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('should use cached client for same config', () => {
    const mockConfig = {
      endpoint: 'https://localhost:9200',
      username: 'admin',
      password: 'cached-test',
    };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req1 = createMockReq();
    const req2 = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req1, res, next);
    storageClientMiddleware(req2, res, next);

    // Same client instance should be reused
    expect(req1.storageClient).toBe(req2.storageClient);
  });

  it('should create new client for different config', () => {
    const mockConfig1 = {
      endpoint: 'https://localhost:9200',
      username: 'admin1',
      password: 'password1',
    };
    const mockConfig2 = {
      endpoint: 'https://localhost:9200',
      username: 'admin2',
      password: 'password2',
    };

    const req1 = createMockReq();
    const req2 = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    mockResolveStorageConfig.mockReturnValue(mockConfig1);
    storageClientMiddleware(req1, res, next);

    mockResolveStorageConfig.mockReturnValue(mockConfig2);
    storageClientMiddleware(req2, res, next);

    // Different client instances for different configs
    expect(req1.storageClient).not.toBe(req2.storageClient);
  });
});

describe('isStorageAvailable', () => {
  it('should return true when storageClient is present', () => {
    const req = createMockReq({
      storageClient: {} as any,
    });

    expect(isStorageAvailable(req)).toBe(true);
  });

  it('should return false when storageClient is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    expect(isStorageAvailable(req)).toBe(false);
  });
});

describe('requireStorageClient', () => {
  it('should return client when present', () => {
    const mockClient = { search: jest.fn() };
    const req = createMockReq({
      storageClient: mockClient as any,
    });

    const result = requireStorageClient(req);
    expect(result).toBe(mockClient);
  });

  it('should throw error when client is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    expect(() => requireStorageClient(req)).toThrow('Storage not configured');
  });
});

describe('getStorageClient', () => {
  it('should return client when present', () => {
    const mockClient = { search: jest.fn() };
    const req = createMockReq({
      storageClient: mockClient as any,
    });

    const result = getStorageClient(req);
    expect(result).toBe(mockClient);
  });

  it('should return null when client is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    const result = getStorageClient(req);
    expect(result).toBeNull();
  });
});

describe('INDEXES', () => {
  it('should export correct index names', () => {
    expect(INDEXES.testCases).toBe('evals_test_cases');
    expect(INDEXES.benchmarks).toBe('evals_experiments');
    expect(INDEXES.runs).toBe('evals_runs');
    expect(INDEXES.analytics).toBe('evals_analytics');
  });
});

describe('drift detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetDriftState();
    mockGetStorageState.mockReturnValue({
      backend: 'file',
      configKey: null,
      error: null,
      configuredEndpoint: null,
    });
  });

  it('should trigger reinit when config key changes', async () => {
    // Current state has null configKey (file storage)
    // New config will produce a different key
    const mockConfig = { endpoint: 'https://new:9200' };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    // Wait for async reinit
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockInitializeStorageFromConfig).toHaveBeenCalledWith(mockConfig);
  });

  it('should not trigger reinit when config key matches', async () => {
    // State and config produce the same key
    const mockConfig = { endpoint: 'https://same:9200' };
    mockResolveStorageConfig.mockReturnValue(mockConfig);
    mockGetStorageState.mockReturnValue({
      backend: 'opensearch',
      configKey: 'basic|https://same:9200||',
      error: null,
      configuredEndpoint: 'https://same:9200',
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockInitializeStorageFromConfig).not.toHaveBeenCalled();
  });

  it('should skip drift check when file_override sentinel is active', async () => {
    mockGetStorageState.mockReturnValue({
      backend: 'file',
      configKey: '__file_override__',
      error: null,
      configuredEndpoint: null,
    });
    const mockConfig = { endpoint: 'https://new:9200' };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockInitializeStorageFromConfig).not.toHaveBeenCalled();
  });

  it('should debounce rapid requests', async () => {
    const mockConfig = { endpoint: 'https://new:9200' };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const next = createMockNext();
    const res = createMockRes();

    // Multiple rapid requests
    storageClientMiddleware(createMockReq(), res, next);
    storageClientMiddleware(createMockReq(), res, next);
    storageClientMiddleware(createMockReq(), res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    // Only one reinit should have been triggered
    expect(mockInitializeStorageFromConfig).toHaveBeenCalledTimes(1);
  });
});
