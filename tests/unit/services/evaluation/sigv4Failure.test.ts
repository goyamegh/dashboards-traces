/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A SigV4 signing/credential failure must surface as a failed agent step with
 * a clear message — never as an unsigned request (and thus an opaque 403).
 */

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/services/opensearch', () => ({
  openSearchClient: { fetchLogsForRun: jest.fn().mockResolvedValue([]) },
}));

const mockFromNodeProviderChain = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => mockFromNodeProviderChain(...args),
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { clearSigV4ProviderCache } from '@/services/connectors/base/awsSigV4';
import type { AgentConfig, TestCase } from '@/types';

const testCase = {
  id: 'tc-sigv4-fail',
  name: 'sigv4 failure',
  initialPrompt: 'search products',
  context: 'ctx',
  expectedOutcomes: ['ok'],
  currentVersion: 1,
  labels: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as TestCase;

describe('aws-sigv4 credential failure → failed report', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    clearSigV4ProviderCache();
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}), headers: new Map() } as unknown as Response);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFromNodeProviderChain.mockReturnValue(
      jest.fn().mockRejectedValue(new Error('Could not load credentials from any providers'))
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports status=failed with the SigV4 reason and never sends the request', async () => {
    const connector = new RESTConnector();
    const registry = {
      getForAgent: jest.fn().mockReturnValue(connector),
      get: jest.fn(),
      getAll: jest.fn().mockReturnValue([connector]),
      has: jest.fn().mockReturnValue(true),
      register: jest.fn(),
    } as any;
    const agent = {
      key: 'sigv4-agent',
      name: 'SigV4 agent',
      endpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke',
      connectorType: 'rest',
      auth: { type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'nonexistent-profile' },
    } as unknown as AgentConfig;

    const report = await runEvaluationWithConnector(agent, 'm', testCase, jest.fn(), { registry });

    expect(report.status).toBe('failed');
    expect(report.llmJudgeReasoning).toBe(
      'Evaluation failed: SigV4 signing failed: Could not load credentials from any providers (profile nonexistent-profile / region us-west-2 / service execute-api)'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('aws-sigv4 credential rejection → the HTTP request is re-signed and re-sent once, inside the connector', () => {
  const EXPIRED_BODY = { message: 'The security token included in the request is expired' };
  const agent = {
    key: 'sigv4-agent',
    name: 'SigV4 agent',
    endpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke',
    connectorType: 'rest',
    auth: { type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'eval' },
  } as unknown as AgentConfig;
  const registryFor = (connector: unknown) =>
    ({ getForAgent: jest.fn().mockReturnValue(connector), get: jest.fn(), getAll: jest.fn().mockReturnValue([connector]), has: jest.fn().mockReturnValue(true), register: jest.fn() }) as any;
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    const map = new Map(Object.entries(headers));
    return {
      ok: status < 400,
      status,
      headers: { get: (n: string) => map.get(n) ?? null, entries: () => map.entries() },
      clone: () => ({ text: async () => text }),
      text: async () => text,
      json: async () => body,
    } as unknown as Response;
  };
  const credentialOf = (fetchMock: jest.SpyInstance, call: number) =>
    ((fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>).authorization.match(/Credential=([^/]+)\//)![1];

  beforeEach(() => {
    clearSigV4ProviderCache();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFromNodeProviderChain.mockReset();
    mockFromNodeProviderChain
      .mockReturnValueOnce(jest.fn().mockResolvedValue({ accessKeyId: 'AKIDSTALE', secretAccessKey: 's' }))
      .mockReturnValue(jest.fn().mockResolvedValue({ accessKeyId: 'AKIDFRESH', secretAccessKey: 's' }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('403 + ExpiredToken body: re-signed with freshly resolved credentials, byte-identical body, exactly one more request', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response(403, EXPIRED_BODY))
      .mockResolvedValueOnce(response(200, { response: 'ok' }));

    const { invokeAgent } = await import('@/services/evaluation');
    const result = await invokeAgent(agent, 'm', testCase, { registry: registryFor(new RESTConnector()) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentialOf(fetchMock, 0)).toBe('AKIDSTALE');
    expect(credentialOf(fetchMock, 1)).toBe('AKIDFRESH');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(result.metadata?.status).toBe(200);
  });

  it('403 with only the x-amzn-errortype header as signal is retried too', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response(403, {}, { 'x-amzn-errortype': 'ExpiredTokenException' }))
      .mockResolvedValueOnce(response(200, { response: 'ok' }));
    const { invokeAgent } = await import('@/services/evaluation');
    await invokeAgent(agent, 'm', testCase, { registry: registryFor(new RESTConnector()) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentialOf(fetchMock, 1)).toBe('AKIDFRESH');
  });

  it('REGRESSION: an HTTP 500 whose body nests a 403 / ExpiredToken is NOT retried — the agent is executed exactly once', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(500, { upstreamStatus: 403, code: 'ExpiredToken' }));

    const report = await runEvaluationWithConnector(agent, 'm', testCase, jest.fn(), { registry: registryFor(new RESTConnector()) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('failed');
    expect(report.llmJudgeReasoning).toBe('Evaluation failed: REST request failed: 500 - {"upstreamStatus":403,"code":"ExpiredToken"}');
  });

  it('REGRESSION: a failure after the connector already emitted progress is NOT retried — execute() runs exactly once', async () => {
    const onStep = jest.fn();
    const execute = jest.fn(async (_endpoint: string, _request: unknown, _auth: unknown, onProgress?: (s: unknown) => void) => {
      onProgress?.({ type: 'action', content: 'did something with side effects', timestamp: Date.now() });
      throw new Error('REST request failed: 403 - {"message":"The security token included in the request is expired"}');
    });
    const connector = { execute, parseResponse: jest.fn().mockReturnValue([]) };

    const { invokeAgent } = await import('@/services/evaluation');
    await expect(invokeAgent(agent, 'm', testCase, { registry: registryFor(connector), onStep })).rejects.toThrow(/REST request failed: 403/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it('a 403 without a credential signal is not retried and surfaces as the failed step', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(403, {}));

    const report = await runEvaluationWithConnector(agent, 'm', testCase, jest.fn(), { registry: registryFor(new RESTConnector()) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('failed');
    expect(report.llmJudgeReasoning).toBe('Evaluation failed: REST request failed: 403 - {}');
  });

  it('a second credential rejection is reported once, after exactly one retry', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(403, EXPIRED_BODY));

    const report = await runEvaluationWithConnector(agent, 'm', testCase, jest.fn(), { registry: registryFor(new RESTConnector()) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentialOf(fetchMock, 1)).toBe('AKIDFRESH');
    expect(report.status).toBe('failed');
    expect(report.llmJudgeReasoning).toBe(`Evaluation failed: REST request failed: 403 - ${JSON.stringify(EXPIRED_BODY)}`);
  });
});
