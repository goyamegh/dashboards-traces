/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import observabilityRoutes from '@/server/routes/observability';

// Mock adapters
jest.mock('@/server/adapters/index', () => ({
  testObservabilityConnection: jest.fn(),
  checkObservabilityHealth: jest.fn(),
}));

// Mock dataSourceConfig
jest.mock('@/server/middleware/dataSourceConfig', () => ({
  resolveObservabilityConfig: jest.fn(),
  DEFAULT_OTEL_INDEXES: {
    traces: 'otel-v1-apm-span-*',
    logs: 'ml-commons-logs-*',
    metrics: 'otel-v1-apm-service-map*',
  },
}));

// Mock configService
jest.mock('@/server/services/configService', () => ({
  getObservabilityConfigFromFile: jest.fn(),
  getObservabilityConfigFromTs: jest.fn(),
}));

import { testObservabilityConnection, checkObservabilityHealth } from '@/server/adapters/index';
import { resolveObservabilityConfig } from '@/server/middleware/dataSourceConfig';
import { getObservabilityConfigFromFile } from '@/server/services/configService';

const mockTestObservabilityConnection = testObservabilityConnection as jest.Mock;
const mockCheckObservabilityHealth = checkObservabilityHealth as jest.Mock;
const mockResolveObservabilityConfig = resolveObservabilityConfig as jest.Mock;
const mockGetObservabilityConfigFromFile = getObservabilityConfigFromFile as jest.Mock;

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

function createMocks(body: any = {}) {
  const req = { body } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Observability Routes', () => {
  // Save and restore env vars touched by these tests so we don't leak state.
  const ENV_KEYS = [
    'OPENSEARCH_LOGS_ENDPOINT',
    'OPENSEARCH_LOGS_AUTH_TYPE',
    'OPENSEARCH_LOGS_USERNAME',
    'OPENSEARCH_LOGS_PASSWORD',
    'OPENSEARCH_LOGS_AWS_PROFILE',
    'OPENSEARCH_LOGS_AWS_REGION',
    'OPENSEARCH_LOGS_AWS_SERVICE',
    'OPENSEARCH_LOGS_TLS_SKIP_VERIFY',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetObservabilityConfigFromFile.mockReturnValue(null);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key]!;
      }
    }
  });

  describe('POST /api/observability/test-connection', () => {
    it('should return error when endpoint is missing', async () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'Endpoint is required' });
    });

    it('should use credentials from request body when provided', async () => {
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'obs-cluster' });

      const { req, res } = createMocks({
        endpoint: 'https://obs-cluster:9200',
        authType: 'sigv4',
        awsRegion: 'us-west-2',
        awsProfile: 'my-profile',
        awsService: 'aoss',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://obs-cluster:9200',
          authType: 'sigv4',
          awsRegion: 'us-west-2',
          awsProfile: 'my-profile',
          awsService: 'aoss',
        })
      );
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', clusterName: 'obs-cluster' });
    });

    it('should fall back to file config when endpoint matches and credentials are not in request body', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue({
        endpoint: 'https://file-obs:9200',
        authType: 'sigv4',
        username: 'file-user',
        password: 'file-pass',
        awsProfile: 'file-profile',
        awsRegion: 'eu-west-1',
        awsService: 'aoss',
        tlsSkipVerify: true,
        indexes: { traces: 'custom-traces-*', logs: 'custom-logs-*', metrics: 'custom-metrics-*' },
      });
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'file-obs' });

      const { req, res } = createMocks({
        endpoint: 'https://file-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://file-obs:9200',
          authType: 'sigv4',
          username: 'file-user',
          password: 'file-pass',
          awsProfile: 'file-profile',
          awsRegion: 'eu-west-1',
          awsService: 'aoss',
          tlsSkipVerify: true,
          indexes: expect.objectContaining({
            traces: 'custom-traces-*',
            logs: 'custom-logs-*',
            metrics: 'custom-metrics-*',
          }),
        })
      );
    });

    it('should NOT fall back to file config credentials when request endpoint differs', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue({
        endpoint: 'https://stored-obs:9200',
        authType: 'basic',
        username: 'file-user',
        password: 'file-pass',
      });
      mockTestObservabilityConnection.mockResolvedValue({ status: 'error', message: 'auth failed' });

      const { req, res } = createMocks({
        endpoint: 'https://attacker-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      const args = mockTestObservabilityConnection.mock.calls[0][0];
      expect(args.endpoint).toBe('https://attacker-obs:9200');
      expect(args.username).toBeUndefined();
      expect(args.password).toBeUndefined();
      expect(args.authType).toBeUndefined();
    });

    it('should fall back to env vars when endpoint matches OPENSEARCH_LOGS_ENDPOINT and no file/body creds', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue(null);
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs:9200';
      process.env.OPENSEARCH_LOGS_USERNAME = 'env-user';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'env-pass';
      process.env.OPENSEARCH_LOGS_AUTH_TYPE = 'basic';
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'env-obs' });

      const { req, res } = createMocks({
        endpoint: 'https://env-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://env-obs:9200',
          username: 'env-user',
          password: 'env-pass',
          authType: 'basic',
        })
      );
    });

    it('should NOT fall back to env vars when endpoint differs from OPENSEARCH_LOGS_ENDPOINT', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue(null);
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs:9200';
      process.env.OPENSEARCH_LOGS_USERNAME = 'env-user';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'env-pass';
      mockTestObservabilityConnection.mockResolvedValue({ status: 'error', message: 'auth failed' });

      const { req, res } = createMocks({
        endpoint: 'https://other-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      const args = mockTestObservabilityConnection.mock.calls[0][0];
      expect(args.endpoint).toBe('https://other-obs:9200');
      expect(args.username).toBeUndefined();
      expect(args.password).toBeUndefined();
    });

    it('should prefer request body over file config and env vars (even when endpoints match)', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue({
        endpoint: 'https://my-obs:9200',
        authType: 'basic',
        username: 'file-user',
        password: 'file-pass',
      });
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://my-obs:9200';
      process.env.OPENSEARCH_LOGS_USERNAME = 'env-user';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'env-pass';
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'test' });

      const { req, res } = createMocks({
        endpoint: 'https://my-obs:9200',
        username: 'body-user',
        password: 'body-pass',
        authType: 'basic',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'body-user',
          password: 'body-pass',
        })
      );
    });

    it('should use file config index patterns as fallback', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue({
        endpoint: 'https://file-obs:9200',
        indexes: { traces: 'file-traces-*', logs: 'file-logs-*', metrics: 'file-metrics-*' },
      });
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'test' });

      const { req, res } = createMocks({
        endpoint: 'https://file-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          indexes: {
            traces: 'file-traces-*',
            logs: 'file-logs-*',
            metrics: 'file-metrics-*',
          },
        })
      );
    });

    it('should use default index patterns when none provided anywhere', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue(null);
      mockTestObservabilityConnection.mockResolvedValue({ status: 'ok', clusterName: 'test' });

      const { req, res } = createMocks({
        endpoint: 'https://obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(mockTestObservabilityConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          indexes: {
            traces: 'otel-v1-apm-span-*',
            logs: 'ml-commons-logs-*',
            metrics: 'otel-v1-apm-service-map*',
          },
        })
      );
    });

    it('should return 500 when testObservabilityConnection throws', async () => {
      mockGetObservabilityConfigFromFile.mockReturnValue(null);
      mockTestObservabilityConnection.mockRejectedValue(new Error('Network timeout'));

      const { req, res } = createMocks({
        endpoint: 'https://timeout-obs:9200',
      });
      const handler = getRouteHandler(observabilityRoutes, 'post', '/api/observability/test-connection');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'Network timeout' });
    });
  });

  describe('GET /api/observability/health', () => {
    it('should return health check result', async () => {
      mockResolveObservabilityConfig.mockReturnValue({ endpoint: 'https://obs:9200' });
      mockCheckObservabilityHealth.mockResolvedValue({ status: 'ok', clusterName: 'obs' });

      const req = {} as unknown as Request;
      const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
      const handler = getRouteHandler(observabilityRoutes, 'get', '/api/observability/health');

      await handler(req, res);

      expect(mockCheckObservabilityHealth).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', clusterName: 'obs' });
    });
  });

  describe('GET /api/observability/defaults', () => {
    it('should return default index patterns', async () => {
      const req = {} as unknown as Request;
      const res = { json: jest.fn().mockReturnThis() } as unknown as Response;
      const handler = getRouteHandler(observabilityRoutes, 'get', '/api/observability/defaults');

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        indexes: {
          traces: 'otel-v1-apm-span-*',
          logs: 'ml-commons-logs-*',
          metrics: 'otel-v1-apm-service-map*',
        },
      });
    });
  });
});
