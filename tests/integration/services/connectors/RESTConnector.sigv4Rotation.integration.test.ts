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

interface Attempt {
  signedWith: string | null;
  verdict: string;
}
interface Request {
  status: number;
  error: string | null;
  attempts: Attempt[];
}
type ProbeResult = { request1: Request; request2InTtlWithSignal: Request; request3InTtlBare: Request; request4AfterTtl: Request };

const A = STATIC_KEY.A.accessKeyId;
const B = STATIC_KEY.B.accessKeyId;

describe('REST connector + aws-sigv4 profile credentials rotated on disk (no restart)', () => {
  let profileDir: AwsProfileDir;
  let result: ProbeResult;

  beforeAll(() => {
    profileDir = createAwsProfileDir();
    result = runTsxProbe<ProbeResult>('tests/fixtures/aws/restConnectorRotationProbe.ts', profileDir.env);
  });

  afterAll(() => profileDir.cleanup());

  it('request 1 is signed with key A from the profile and the server accepts the recomputed signature', () => {
    expect(result.request1).toEqual({ status: 200, error: null, attempts: [{ signedWith: A, verdict: 'ok' }] });
  });

  it('after the rotation, a 403 "security token … expired" for the stale key is re-signed with the key now on disk and replayed exactly once → 200 (same process, inside the TTL)', () => {
    expect(result.request2InTtlWithSignal.attempts).toEqual([
      { signedWith: A, verdict: 'The security token included in the request is expired' },
      { signedWith: B, verdict: 'ok' },
    ]);
    expect(result.request2InTtlWithSignal).toMatchObject({ status: 200, error: null });
  });

  it('a bare `403 {}` for a stale key (no credential signal) is NOT replayed — one attempt, the bounded failure window', () => {
    expect(result.request3InTtlBare.attempts).toEqual([{ signedWith: B, verdict: 'bare' }]);
    expect(result.request3InTtlBare.status).toBe(403);
    expect(result.request3InTtlBare.error).toBe('REST request failed: 403 - {}');
  });

  it('after the TTL the SAME connector in the SAME process re-reads the profile and signs with the current key → 200', () => {
    expect(result.request4AfterTtl).toEqual({ status: 200, error: null, attempts: [{ signedWith: A, verdict: 'ok' }] });
  });
});
