/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for #569: an eval against an `aws-sigv4` REST agent kept
 * failing with `REST request failed: 403 - {}` after the AWS profile on disk
 * was refreshed, until the server was restarted.
 *
 * Real `RESTConnector` + real SigV4 signer + real AWS credential chain, in ONE
 * long-lived child process (tsx — the chain's dynamic `import()` cannot run
 * inside Jest's CJS VM), against a local HTTP server that recomputes the
 * signature with the key it currently trusts. See
 * tests/fixtures/aws/restConnectorRotationProbe.ts for the sequence.
 */

import {
  STATIC_KEY,
  createAwsProfileDir,
  runTsxProbe,
  type AwsProfileDir,
} from '../../../helpers/awsCredentialRotation';

interface Request {
  status: number;
  error: string | null;
  signedWith: string | null;
  verdict: string;
}
type ProbeResult = {
  request1: Request;
  request2InTtl: Request;
  request3AfterTtl: Request;
  request4ViaInvokeAgent: { status: number; error: string | null; attempts: Array<Pick<Request, 'signedWith' | 'verdict'>> };
};

describe('REST connector + aws-sigv4 profile credentials rotated on disk (no restart)', () => {
  let profileDir: AwsProfileDir;
  let result: ProbeResult;

  beforeAll(() => {
    profileDir = createAwsProfileDir();
    result = runTsxProbe<ProbeResult>('tests/fixtures/aws/restConnectorRotationProbe.ts', profileDir.env);
  });

  afterAll(() => profileDir.cleanup());

  it('request 1 is signed with key A from the profile and the server accepts the recomputed signature', () => {
    expect(result.request1).toEqual({ status: 200, error: null, signedWith: STATIC_KEY.A.accessKeyId, verdict: 'ok' });
  });

  it('inside the TTL after the rotation the connector still signs with A — the bounded failure window (403)', () => {
    expect(result.request2InTtl.signedWith).toBe(STATIC_KEY.A.accessKeyId);
    expect(result.request2InTtl.status).toBe(403);
    expect(result.request2InTtl.error).toMatch(/REST request failed: 403/);
  });

  it('after the TTL the SAME connector in the SAME process signs with key B and is accepted', () => {
    expect(result.request3AfterTtl).toEqual({ status: 200, error: null, signedWith: STATIC_KEY.B.accessKeyId, verdict: 'ok' });
  });

  it('through invokeAgent, a 403 ExpiredToken for a just-rotated key is re-signed with fresh credentials and retried once → 200', () => {
    expect(result.request4ViaInvokeAgent.attempts).toEqual([
      { signedWith: STATIC_KEY.B.accessKeyId, verdict: 'The security token included in the request is expired' },
      { signedWith: STATIC_KEY.A.accessKeyId, verdict: 'ok' },
    ]);
    expect(result.request4ViaInvokeAgent).toMatchObject({ status: 200, error: null });
  });
});
