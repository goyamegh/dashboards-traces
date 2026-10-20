/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract test against the REAL AWS SDK (no mocks): proves the root cause
 * of #569 — the stock credential chain, and any SDK client on it, keeps the
 * first static profile key for the life of the process — and that the
 * refreshing provider makes both a bare signer and a `BedrockRuntimeClient`
 * pick up a rotated `~/.aws/credentials` once the TTL elapses.
 *
 * Runs the probe in a child Node process (tsx): the chain uses dynamic
 * `import()`, which Jest's CJS VM cannot execute.
 */

import {
  STATIC_KEY,
  createAwsProfileDir,
  runTsxProbe,
  type AwsProfileDir,
} from '../../../helpers/awsCredentialRotation';

type Snapshot = { before: string; inTtl: string; afterTtl: string };
type ProbeResult = Record<'stockChain' | 'defaultChainClient' | 'refreshingProvider' | 'refreshingClient', Snapshot>;

describe('refreshing credential provider vs the real AWS SDK', () => {
  let profileDir: AwsProfileDir;
  let result: ProbeResult;

  beforeAll(() => {
    profileDir = createAwsProfileDir();
    result = runTsxProbe<ProbeResult>('tests/fixtures/aws/credentialRotationProbe.ts', profileDir.env);
  });

  afterAll(() => profileDir.cleanup());

  it('every path resolves key A before the rotation', () => {
    for (const snap of Object.values(result)) expect(snap.before).toBe(STATIC_KEY.A.accessKeyId);
  });

  it('control (the bug): the stock memoised chain never re-reads a rotated static profile', () => {
    expect(result.stockChain.afterTtl).toBe(STATIC_KEY.A.accessKeyId);
  });

  it('control (the bug): an SDK client on the default chain keeps the first key after rotation', () => {
    expect(result.defaultChainClient.afterTtl).toBe(STATIC_KEY.A.accessKeyId);
  });

  it('the refreshing provider reuses key A inside the TTL and resolves key B after it', () => {
    expect(result.refreshingProvider.inTtl).toBe(STATIC_KEY.A.accessKeyId);
    expect(result.refreshingProvider.afterTtl).toBe(STATIC_KEY.B.accessKeyId);
  });

  it('a BedrockRuntimeClient given the refreshing provider re-invokes it (synthetic expiration) and sees key B after the TTL', () => {
    expect(result.refreshingClient.inTtl).toBe(STATIC_KEY.A.accessKeyId);
    expect(result.refreshingClient.afterTtl).toBe(STATIC_KEY.B.accessKeyId);
  });
});
