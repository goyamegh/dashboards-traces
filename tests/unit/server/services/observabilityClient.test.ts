/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** The observability factory picks the backend from `observability.type`. */

jest.mock('@/server/middleware/dataSourceConfig', () => ({
  resolveObservabilityConfig: jest.fn(),
  resolveObservabilitySources: jest.fn(),
  DEFAULT_OTEL_INDEXES: { traces: 'otel-v1-apm-span-*', logs: 'ml-commons-logs-*', metrics: 'otel-v1-apm-service-map*' },
}));
jest.mock('@/server/services/opensearchClientFactory', () => ({
  createOpenSearchClient: jest.fn(() => ({ close: jest.fn().mockResolvedValue(undefined) })),
  configToCacheKey: jest.fn((c: any) => `${c.endpoint}`),
  resolveSigv4Credentials: jest.fn(),
}));

import { resolveObservabilityConfig, resolveObservabilitySources } from '@/server/middleware/dataSourceConfig';
import {
  getObservabilityModule,
  createObservabilityModule,
  cloudWatchCacheKey,
  __resetObservabilityCachesForTests,
} from '@/server/services/observabilityClient';

const mockResolve = resolveObservabilityConfig as jest.Mock;
const mockSources = resolveObservabilitySources as jest.Mock;
const req = {} as any;

beforeEach(() => {
  jest.clearAllMocks();
  __resetObservabilityCachesForTests();
  // By default the sources list mirrors the single primary config.
  mockSources.mockImplementation(() => {
    const c = mockResolve();
    return c ? [{ ...c, id: 'primary', name: 'primary' }] : [];
  });
});

describe('getObservabilityModule', () => {
  it('returns the file backend when nothing is configured', () => {
    mockResolve.mockReturnValue(null);
    expect(getObservabilityModule(req).describe().type).toBe('file');
  });

  it('returns the OpenSearch backend for an endpoint config (default type)', () => {
    mockResolve.mockReturnValue({ endpoint: 'https://os.example', indexes: { traces: 'tr-*' } });
    const mod = getObservabilityModule(req);
    expect(mod.describe()).toEqual({ type: 'opensearch', target: 'tr-*' });
  });

  it('returns the CloudWatch backend for type cloudwatch and caches it per region/profile/log groups', () => {
    const cfg = { type: 'cloudwatch', awsRegion: 'us-east-1', awsProfile: 'p', logGroups: { traces: 'aws/spans', logs: '/agent-health/{service.name}' } };
    mockResolve.mockReturnValue(cfg);
    const a = getObservabilityModule(req);
    const b = getObservabilityModule(req);
    expect(a.describe()).toEqual({ type: 'cloudwatch', target: 'aws/spans', region: 'us-east-1' });
    expect(b).toBe(a);
    mockResolve.mockReturnValue({ ...cfg, awsProfile: 'other' });
    expect(getObservabilityModule(req)).not.toBe(a);
    expect(cloudWatchCacheKey(cfg as any)).toBe('cloudwatch|us-east-1|p|aws/spans|/agent-health/{service.name}');
  });
});

describe('getObservabilityModule with several sources', () => {
  it('returns a composite over every source, in order', () => {
    mockSources.mockReturnValue([
      { id: 'primary', name: 'primary', endpoint: 'https://mine.example', indexes: { traces: 'tr-*' } },
      { id: 'cw', name: 'Team CloudWatch', type: 'cloudwatch', awsRegion: 'us-east-1', logGroups: { traces: 'aws/spans', logs: '/agent-health/{service.name}' } },
    ]);
    const mod = getObservabilityModule(req);
    expect(mod.describe()).toEqual({ type: 'composite', target: 'primary (opensearch) + Team CloudWatch (cloudwatch)' });
  });
});

describe('createObservabilityModule', () => {
  it('rejects a CloudWatch config without a region and an OpenSearch config without an endpoint', () => {
    expect(() => createObservabilityModule({ type: 'cloudwatch' } as any)).toThrow(/awsRegion is required/);
    expect(() => createObservabilityModule({} as any)).toThrow(/endpoint is required/);
    expect(createObservabilityModule(null).describe().type).toBe('file');
  });
});
