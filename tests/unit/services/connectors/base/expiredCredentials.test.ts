/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isExpiredCredentialsError, retryOnceOnExpiredCredentials } from '@/services/connectors/base/expiredCredentials';
import type { ConnectorAuth } from '@/services/connectors/types';

const SIGV4: ConnectorAuth = { type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'eval' };
const expired = () => new Error('REST request failed: 403 - {"message":"The security token included in the request is expired"}');

describe('isExpiredCredentialsError', () => {
  it.each([
    'REST request failed: 403 - {"message":"The security token included in the request is expired"}',
    'REST request failed: 403 - {"message":"The security token included in the request is invalid."}',
    'OpenAI-compatible request failed: 403 - {"__type":"ExpiredTokenException","message":"…"}',
    'LangGraph request failed: 403 - <ErrorResponse><Error><Code>ExpiredToken</Code></Error></ErrorResponse>',
    'HTTP 403: Forbidden - {"__type":"UnrecognizedClientException"}',
    'REST request failed: 401 - {"Code":"InvalidClientTokenId"}',
  ])('recognises %s', (message) => {
    expect(isExpiredCredentialsError(new Error(message))).toBe(true);
  });

  it.each([
    'REST request failed: 403 - {}', // the bare 403 from the report: no credential signal → not retried
    'REST request failed: 403 - {"Message":"User: arn:aws:sts::123:assumed-role/x is not authorized to perform: execute-api:Invoke"}',
    'REST request failed: 403 - {"message":"SignatureDoesNotMatch"}',
    'REST request failed: 500 - ExpiredTokenException', // a credential signal without a 401/403
    'fetch failed',
    'SigV4 signing failed: Could not load credentials from any providers (profile eval / region r / service s)',
  ])('does not match %s', (message) => {
    expect(isExpiredCredentialsError(new Error(message))).toBe(false);
  });

  it('accepts non-Error throwables', () => {
    expect(isExpiredCredentialsError('HTTP 403: ExpiredToken')).toBe(true);
  });
});

describe('retryOnceOnExpiredCredentials', () => {
  it('refreshes credentials and runs the attempt exactly once more after an expired-credentials 403', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const attempt = jest.fn().mockRejectedValueOnce(expired()).mockResolvedValueOnce('ok');

    await expect(retryOnceOnExpiredCredentials(SIGV4, attempt, refresh)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(attempt.mock.invocationCallOrder[1]); // refresh BEFORE the retry
  });

  it('does not retry a non-credential 403, a non-SigV4 auth block, or a network error', async () => {
    const refresh = jest.fn();
    const denied = new Error('REST request failed: 403 - {"Message":"not authorized to perform: execute-api:Invoke"}');
    const attempt = jest.fn().mockRejectedValue(denied);
    await expect(retryOnceOnExpiredCredentials(SIGV4, attempt, refresh)).rejects.toBe(denied);
    expect(attempt).toHaveBeenCalledTimes(1);

    const bearer = jest.fn().mockRejectedValue(expired());
    await expect(retryOnceOnExpiredCredentials({ type: 'bearer', token: 't' }, bearer, refresh)).rejects.toThrow(/expired/);
    expect(bearer).toHaveBeenCalledTimes(1);

    const network = jest.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(retryOnceOnExpiredCredentials(SIGV4, network, refresh)).rejects.toThrow('fetch failed');
    expect(network).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a second failure surfaces the original error annotated with the retry, and never retries again', async () => {
    const attempt = jest.fn().mockRejectedValue(expired());
    const err = await retryOnceOnExpiredCredentials(SIGV4, attempt, jest.fn().mockResolvedValue(undefined)).catch((e) => e);
    expect(err.message).toBe(
      'REST request failed: 403 - {"message":"The security token included in the request is expired"} ' +
        '(retried once with refreshed credentials; retry failed: REST request failed: 403 - {"message":"The security token included in the request is expired"})'
    );
    expect(err.cause).toBeInstanceOf(Error);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('a failed refresh is reported as the retry failure (not swallowed) and the attempt is not re-run', async () => {
    const attempt = jest.fn().mockRejectedValue(expired());
    const refresh = jest.fn().mockRejectedValue(new Error('Could not load credentials from any providers'));
    await expect(retryOnceOnExpiredCredentials(SIGV4, attempt, refresh)).rejects.toThrow(
      /retried once with refreshed credentials; retry failed: Could not load credentials from any providers/
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
