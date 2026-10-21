/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real `Response` objects (undici) — the classifier must decide from the
 * status and the recognised TOP-LEVEL AWS error fields only.
 */

import { isAwsCredentialRejection } from '@/services/connectors/base/expiredCredentials';

const res = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe('isAwsCredentialRejection', () => {
  describe('rejections (replay is allowed)', () => {
    it.each([
      ['header alone decides, with the coral suffix stripped', res(403, '{}', { 'x-amzn-ErrorType': 'ExpiredTokenException:http://internal.amazon.com/coral/com.amazon.coral.service/' })],
      ['header UnrecognizedClientException, empty body', res(403, '', { 'x-amzn-errortype': 'UnrecognizedClientException' })],
      ['header InvalidClientTokenId on a 401', res(401, '', { 'x-amzn-errortype': 'InvalidClientTokenId' })],
      ['JSON __type', res(403, '{"__type":"ExpiredTokenException","message":"The security token included in the request is expired"}')],
      ['JSON __type with a namespace prefix', res(403, '{"__type":"com.amazon.coral.service#ExpiredTokenException"}')],
      ['JSON code', res(403, '{"code":"ExpiredToken","message":"…"}')],
      ['JSON Code (STS casing)', res(403, '{"Code":"InvalidClientTokenId","Message":"The security token included in the request is invalid."}')],
      ['JSON top-level message only (API Gateway)', res(403, '{"message":"The security token included in the request is expired"}')],
      ['JSON top-level Message only', res(403, '{"Message":"The security token included in the request is invalid."}')],
      ['XML <Error><Code>', res(403, '<ErrorResponse><Error><Type>Sender</Type><Code>ExpiredToken</Code><Message>…</Message></Error></ErrorResponse>')],
    ])('%s', async (_name, response) => {
      await expect(isAwsCredentialRejection(response)).resolves.toBe(true);
    });
  });

  describe('not rejections (never replayed)', () => {
    it.each([
      ["reviewer's case: 403 + x-amzn-errortype AccessDeniedException + a NESTED diagnostic.code ExpiredToken — the header decides",
        res(403, '{"message":"Forbidden","diagnostic":{"code":"ExpiredToken","upstreamStatus":403}}', { 'x-amzn-errortype': 'AccessDeniedException' })],
      ['nested code without a header is never read', res(403, '{"message":"Forbidden","diagnostic":{"code":"ExpiredToken"}}')],
      ['explicit top-level type conflicts with a credential-looking message → the type wins', res(403, '{"__type":"AccessDeniedException","message":"The security token included in the request is expired"}')],
      ['the bare 403 from the report', res(403, '{}')],
      ['IAM authorization denial', res(403, '{"Message":"User: arn:aws:sts::123:assumed-role/x is not authorized to perform: execute-api:Invoke"}')],
      ['SignatureDoesNotMatch', res(403, '{"message":"SignatureDoesNotMatch"}')],
      ['a message that merely CONTAINS the AWS text', res(403, '{"message":"upstream said: The security token included in the request is expired, see logs"}')],
      ['ExpiredToken mentioned in a free-text body (no JSON/XML structure)', res(403, 'ExpiredToken: please retry')],
      ['a 500 whose body nests a 403 / ExpiredToken', res(500, '{"upstreamStatus":403,"code":"ExpiredToken"}')],
      ['a 502 with the header', res(502, '', { 'x-amzn-errortype': 'ExpiredTokenException' })],
      ['a 200 with an error-looking body', res(200, '{"__type":"ExpiredTokenException"}')],
      ['XML: <Code> only nested under <Detail>', res(403, '<ErrorResponse><Error><Code>AccessDenied</Code><Detail><Code>ExpiredToken</Code></Detail></Error></ErrorResponse>')],
      ['JSON array body', res(403, '[{"code":"ExpiredToken"}]')],
      ['malformed JSON', res(403, '{"code":"ExpiredToken"')],
    ])('%s', async (_name, response) => {
      await expect(isAwsCredentialRejection(response)).resolves.toBe(false);
    });
  });

  it('reads the body from a clone so the caller can still consume it', async () => {
    const r = res(403, '{"__type":"ExpiredTokenException"}');
    await expect(isAwsCredentialRejection(r)).resolves.toBe(true);
    expect(r.bodyUsed).toBe(false);
    await expect(r.text()).resolves.toBe('{"__type":"ExpiredTokenException"}');
  });

  it('is false when the body cannot be read or the response cannot be cloned', async () => {
    await expect(
      isAwsCredentialRejection({ status: 403, headers: { get: () => null }, clone: () => ({ text: () => Promise.reject(new Error('boom')) }) })
    ).resolves.toBe(false);
    await expect(isAwsCredentialRejection({ status: 403, headers: { get: () => null } })).resolves.toBe(false);
  });
});
