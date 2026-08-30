/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the same root cause fixed in opensearchClientFactory.ts
 * (see resolveSigv4Credentials()): @smithy/shared-ini-file-loader memoizes the
 * raw contents of ~/.aws/credentials for the lifetime of the Node process,
 * keyed only by file path — a brand-new `fromNodeProviderChain()` call does
 * NOT bypass that cache on its own. `validateAwsCredentials()` explicitly
 * advertises "not just locally cached" in its doc comment, so it must pass
 * `ignoreCache: true` or that guarantee is false for a long-running server
 * (the exact "still 403 after ada rotated creds" incident, applied to this
 * check instead of the OpenSearch client).
 */

const mockFromNodeProviderChain = jest.fn().mockReturnValue('mock-credentials-provider');
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: mockFromNodeProviderChain,
}));

const mockSend = jest.fn().mockResolvedValue({ modelSummaries: [] });
const mockBedrockClient = jest.fn().mockImplementation(() => ({ send: mockSend }));
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: mockBedrockClient,
  ListFoundationModelsCommand: jest.fn(),
}));

import { validateAwsCredentials } from '@/server/services/tracesService';

describe('validateAwsCredentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ modelSummaries: [] });
  });

  it('always passes ignoreCache: true so a rotated ~/.aws/credentials is re-read from disk instead of the process-lifetime file cache', async () => {
    await validateAwsCredentials('default');

    expect(mockFromNodeProviderChain).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreCache: true })
    );
  });

  it('passes ignoreCache: true even with no profile given', async () => {
    await validateAwsCredentials();

    expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ ignoreCache: true });
  });

  it('still forwards the profile alongside ignoreCache', async () => {
    await validateAwsCredentials('MyProfile');

    expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'MyProfile', ignoreCache: true });
  });

  it('returns null when the real API call succeeds', async () => {
    const result = await validateAwsCredentials('default');
    expect(result).toBeNull();
  });

  it('returns an actionable message when credentials are expired/invalid', async () => {
    mockSend.mockRejectedValue(new Error('The security token included in the request is expired'));

    const result = await validateAwsCredentials('default');

    expect(result).toContain('expired or invalid');
    expect(result).toContain('default');
  });
});
