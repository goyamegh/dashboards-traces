/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the data-source resolution precedence (#261).
 *
 * resolveStorageConfig / resolveObservabilityConfig resolve in this order:
 *   1. agent-health.config.json  (getStorageConfigFromFile)
 *   2. agent-health.config.ts    (getStorageConfigFromTs)
 *   3. OPENSEARCH_* env vars
 *   4. null (file-based fallback)
 */

jest.mock('@/server/services/configService', () => ({
  getStorageConfigFromFile: jest.fn().mockReturnValue(null),
  getObservabilityConfigFromFile: jest.fn().mockReturnValue(null),
  getStorageConfigFromTs: jest.fn().mockReturnValue(null),
  getObservabilityConfigFromTs: jest.fn().mockReturnValue(null),
  getObservabilitySourcesFromTs: jest.fn().mockReturnValue([]),
  getObservabilitySourcesFromFile: jest.fn().mockReturnValue([]),
}));

import {
  resolveStorageConfig,
  resolveObservabilityConfig,
  resolveObservabilitySources,
  DEFAULT_OTEL_INDEXES,
} from '@/server/middleware/dataSourceConfig';
import {
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
  getStorageConfigFromTs,
  getObservabilityConfigFromTs,
  getObservabilitySourcesFromTs,
  getObservabilitySourcesFromFile,
} from '@/server/services/configService';
const mockSrcTs = getObservabilitySourcesFromTs as jest.Mock;
const mockSrcFile = getObservabilitySourcesFromFile as jest.Mock;

const mockStorageFile = getStorageConfigFromFile as jest.Mock;
const mockObsFile = getObservabilityConfigFromFile as jest.Mock;
const mockStorageTs = getStorageConfigFromTs as jest.Mock;
const mockObsTs = getObservabilityConfigFromTs as jest.Mock;

const req = {} as any;

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockStorageFile.mockReturnValue(null);
  mockObsFile.mockReturnValue(null);
  mockStorageTs.mockReturnValue(null);
  mockObsTs.mockReturnValue(null);
  mockSrcTs.mockReturnValue([]);
  mockSrcFile.mockReturnValue([]);
  process.env = { ...OLD_ENV };
  delete process.env.OPENSEARCH_STORAGE_ENDPOINT;
  delete process.env.OPENSEARCH_STORAGE_USERNAME;
  delete process.env.OPENSEARCH_LOGS_ENDPOINT;
  delete process.env.OPENSEARCH_LOGS_TRACES_INDEX;
  delete process.env.OBSERVABILITY_TYPE;
  delete process.env.CLOUDWATCH_REGION;
  delete process.env.CLOUDWATCH_AWS_PROFILE;
  delete process.env.CLOUDWATCH_TRACES_LOG_GROUP;
  delete process.env.CLOUDWATCH_LOGS_LOG_GROUP;
  delete process.env.AWS_REGION; // CLOUDWATCH_REGION falls back to it
});

describe('resolveObservabilityConfig — CloudWatch backend', () => {
  it('fills log-group defaults for a TS CloudWatch config and drops OpenSearch-only fields', () => {
    mockObsTs.mockReturnValue({ type: 'cloudwatch', awsRegion: 'us-east-1', awsProfile: 'default' });
    const cfg = resolveObservabilityConfig(req);
    expect(cfg).toMatchObject({
      type: 'cloudwatch',
      awsRegion: 'us-east-1',
      awsProfile: 'default',
      logGroups: { traces: 'aws/spans', logs: '/agent-health/{service.name}' },
    });
    expect(cfg?.endpoint).toBeUndefined();
    expect(cfg?.indexes).toBeUndefined();
  });

  it('honours custom log groups', () => {
    mockObsFile.mockReturnValue({ type: 'cloudwatch', awsRegion: 'us-east-1', logGroups: { logs: '/my/{service.name}' } });
    expect(resolveObservabilityConfig(req)?.logGroups).toEqual({ traces: 'aws/spans', logs: '/my/{service.name}' });
  });

  it('resolves CloudWatch from env (OBSERVABILITY_TYPE + CLOUDWATCH_*)', () => {
    process.env.OBSERVABILITY_TYPE = 'cloudwatch';
    process.env.CLOUDWATCH_REGION = 'us-west-2';
    process.env.CLOUDWATCH_AWS_PROFILE = 'obs';
    process.env.CLOUDWATCH_TRACES_LOG_GROUP = 'custom/spans';
    const cfg = resolveObservabilityConfig(req);
    expect(cfg).toMatchObject({ type: 'cloudwatch', awsRegion: 'us-west-2', awsProfile: 'obs', logGroups: { traces: 'custom/spans', logs: '/agent-health/{service.name}' } });
  });

  it('CloudWatch env without a region is not configured (AWS_REGION is an accepted fallback); OpenSearch env still wins when type is not cloudwatch', () => {
    process.env.OBSERVABILITY_TYPE = 'cloudwatch';
    expect(resolveObservabilityConfig(req)).toBeNull();
    process.env.AWS_REGION = 'ap-south-1';
    expect(resolveObservabilityConfig(req)?.awsRegion).toBe('ap-south-1');
    delete process.env.AWS_REGION;
    delete process.env.OBSERVABILITY_TYPE;
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs.com';
    expect(resolveObservabilityConfig(req)).toMatchObject({ type: 'opensearch', endpoint: 'https://env-obs.com' });
  });

  it('an OpenSearch config is tagged type opensearch', () => {
    mockObsTs.mockReturnValue({ endpoint: 'https://ts-obs.com' });
    expect(resolveObservabilityConfig(req)?.type).toBe('opensearch');
  });
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe('resolveStorageConfig precedence', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveStorageConfig(req)).toBeNull();
  });

  it('uses TS config when JSON file is absent', () => {
    mockStorageTs.mockReturnValue({ endpoint: 'https://ts-store.com', authType: 'sigv4' });
    expect(resolveStorageConfig(req)).toEqual({ endpoint: 'https://ts-store.com', authType: 'sigv4' });
  });

  it('prefers JSON file config over TS config', () => {
    mockStorageFile.mockReturnValue({ endpoint: 'https://json-store.com' });
    mockStorageTs.mockReturnValue({ endpoint: 'https://ts-store.com' });
    expect(resolveStorageConfig(req)?.endpoint).toBe('https://json-store.com');
  });

  it('prefers TS config over env vars', () => {
    process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-store.com';
    mockStorageTs.mockReturnValue({ endpoint: 'https://ts-store.com' });
    expect(resolveStorageConfig(req)?.endpoint).toBe('https://ts-store.com');
  });

  it('falls through to env vars when neither JSON nor TS present', () => {
    process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-store.com';
    process.env.OPENSEARCH_STORAGE_USERNAME = 'env-user';
    const cfg = resolveStorageConfig(req);
    expect(cfg?.endpoint).toBe('https://env-store.com');
    expect(cfg?.username).toBe('env-user');
  });
});

describe('resolveObservabilityConfig precedence', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveObservabilityConfig(req)).toBeNull();
  });

  it('uses TS config (with index defaults) when JSON file is absent', () => {
    mockObsTs.mockReturnValue({ endpoint: 'https://ts-obs.com' });
    const cfg = resolveObservabilityConfig(req);
    expect(cfg?.endpoint).toBe('https://ts-obs.com');
    // Index patterns fall back to defaults when not specified.
    expect(cfg?.indexes?.traces).toBe(DEFAULT_OTEL_INDEXES.traces);
    expect(cfg?.indexes?.logs).toBe(DEFAULT_OTEL_INDEXES.logs);
  });

  it('honors custom indexes from TS config', () => {
    mockObsTs.mockReturnValue({ endpoint: 'https://ts-obs.com', indexes: { traces: 'custom-traces-*' } });
    const cfg = resolveObservabilityConfig(req);
    expect(cfg?.indexes?.traces).toBe('custom-traces-*');
    expect(cfg?.indexes?.logs).toBe(DEFAULT_OTEL_INDEXES.logs);
  });

  it('prefers JSON file config over TS config', () => {
    mockObsFile.mockReturnValue({ endpoint: 'https://json-obs.com' });
    mockObsTs.mockReturnValue({ endpoint: 'https://ts-obs.com' });
    expect(resolveObservabilityConfig(req)?.endpoint).toBe('https://json-obs.com');
  });

  it('prefers TS config over env vars', () => {
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs.com';
    mockObsTs.mockReturnValue({ endpoint: 'https://ts-obs.com' });
    expect(resolveObservabilityConfig(req)?.endpoint).toBe('https://ts-obs.com');
  });

  it('falls through to env vars when neither JSON nor TS present', () => {
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs.com';
    process.env.OPENSEARCH_LOGS_TRACES_INDEX = 'env-traces-*';
    const cfg = resolveObservabilityConfig(req);
    expect(cfg?.endpoint).toBe('https://env-obs.com');
    expect(cfg?.indexes?.traces).toBe('env-traces-*');
  });
});

describe('resolveObservabilitySources — several sources read side by side', () => {
  it('returns nothing when nothing is configured', () => {
    expect(resolveObservabilitySources(req)).toEqual([]);
  });

  it('the primary comes first (as "primary"), then TS-authored sources, then state-file sources; defaults applied per type', () => {
    mockObsTs.mockReturnValue({ endpoint: 'https://mine.example' });
    mockSrcTs.mockReturnValue([{ id: 'team-cw', name: 'Team CloudWatch', type: 'cloudwatch', awsRegion: 'us-east-1' }]);
    const list = resolveObservabilitySources(req);
    expect(list.map((s) => [s.id, s.name, s.type])).toEqual([['primary', 'primary', 'opensearch'], ['team-cw', 'Team CloudWatch', 'cloudwatch']]);
    expect(list[0].indexes?.traces).toBe(DEFAULT_OTEL_INDEXES.traces);
    expect(list[1].logGroups).toEqual({ traces: 'aws/spans', logs: '/agent-health/{service.name}' });
  });

  it('code-first mode (any TS observability config) ignores state-file sources, exactly like the primary', () => {
    mockObsTs.mockReturnValue({ endpoint: 'https://mine.example' });
    mockSrcFile.mockReturnValue([{ id: 'ui-added', type: 'cloudwatch', awsRegion: 'us-west-2' }]);
    expect(resolveObservabilitySources(req).map((s) => s.id)).toEqual(['primary']);
  });

  it('ui-first mode: state-file sources are read; a source id used twice is kept once', () => {
    mockObsFile.mockReturnValue({ endpoint: 'https://mine.example' });
    mockSrcFile.mockReturnValue([
      { id: 'cw', type: 'cloudwatch', awsRegion: 'us-west-2' },
      { id: 'cw', type: 'cloudwatch', awsRegion: 'eu-west-1' },
      { id: 'other', endpoint: 'https://other.example' },
    ]);
    const list = resolveObservabilitySources(req);
    expect(list.map((s) => [s.id, s.name])).toEqual([['primary', 'primary'], ['cw', 'cw'], ['other', 'other']]);
    expect(list[1].awsRegion).toBe('us-west-2');
  });

  it('additional sources alone (no primary) still form the list', () => {
    mockSrcFile.mockReturnValue([{ id: 'cw', type: 'cloudwatch', awsRegion: 'us-west-2' }]);
    expect(resolveObservabilitySources(req).map((s) => s.id)).toEqual(['cw']);
  });
});
