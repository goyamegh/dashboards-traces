/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAwsCredentialRejection } from '@/services/connectors/base/expiredCredentials';

function response(status: number, body: string, headers: Record<string, string> = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let consumed = false;
  return {
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    clone: () => ({ text: async () => body }),
    text: async () => {
      consumed = true;
      return body;
    },
    get consumed() {
      return consumed;
    },
  };
}

describe('isAwsCredentialRejection', () => {
  it.each([
    [403, '{"message":"The security token included in the request is expired"}', {}],
    [403, '{"message":"The security token included in the request is invalid."}', {}],
    [403, '{"__type":"ExpiredTokenException","message":"…"}', {}],
    [403, '<ErrorResponse><Error><Code>ExpiredToken</Code></Error></ErrorResponse>', {}],
    [403, '{}', { 'x-amzn-ErrorType': 'ExpiredTokenException' }], // header signal, empty body
    [403, '', { 'x-amzn-errortype': 'UnrecognizedClientException:http://internal.amazon.com/coral/com.amazon.coral.service/' }],
    [401, '{"Code":"InvalidClientTokenId"}', {}],
  ])('status %s with %s %j → rejection', async (status, body, headers) => {
    await expect(isAwsCredentialRejection(response(status, body, headers))).resolves.toBe(true);
  });

  it.each([
    [403, '{}', {}], // the bare 403 from the report: no credential signal → not a credential rejection
    [403, '{"Message":"User: arn:aws:sts::123:assumed-role/x is not authorized to perform: execute-api:Invoke"}', {}],
    [403, '{"message":"SignatureDoesNotMatch"}', {}],
    [403, '{"message":"Forbidden"}', { 'x-amzn-errortype': 'AccessDeniedException' }],
    [500, '{"upstreamStatus":403,"code":"ExpiredToken"}', {}], // a nested 403/ExpiredToken inside a 500 is NOT our rejection
    [502, 'ExpiredTokenException', { 'x-amzn-errortype': 'ExpiredTokenException' }],
    [200, '{"error":"ExpiredToken"}', {}],
  ])('status %s with %s %j → not a rejection', async (status, body, headers) => {
    await expect(isAwsCredentialRejection(response(status, body, headers))).resolves.toBe(false);
  });

  it('reads the body from a clone so the caller can still consume it', async () => {
    const r = response(403, '{"__type":"ExpiredTokenException"}');
    await expect(isAwsCredentialRejection(r)).resolves.toBe(true);
    expect(r.consumed).toBe(false);
    await expect(r.text()).resolves.toBe('{"__type":"ExpiredTokenException"}');
  });

  it('is false when the body cannot be read or the response cannot be cloned', async () => {
    await expect(
      isAwsCredentialRejection({ status: 403, headers: { get: () => null }, clone: () => ({ text: () => Promise.reject(new Error('boom')) }) })
    ).resolves.toBe(false);
    await expect(isAwsCredentialRejection({ status: 403, headers: { get: () => null } })).resolves.toBe(false);
  });
});
