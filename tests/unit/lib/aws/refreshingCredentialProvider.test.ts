/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Logic of the refreshing provider with the AWS chain mocked. The claims that
 * depend on the REAL SDK (the stock chain never re-reads a rotated static
 * profile; an SDK client only re-invokes a provider whose identity carries an
 * `expiration`) are proven in refreshingCredentialProvider.realSdk.test.ts.
 */

const mockFromNodeProviderChain = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => mockFromNodeProviderChain(...args),
}));

import {
  DEFAULT_CREDENTIAL_TTL_MS,
  createRefreshingCredentialProvider,
} from '@/lib/aws/refreshingCredentialProvider';

const KEY_A = { accessKeyId: 'AKIDA', secretAccessKey: 'sa', sessionToken: 'ta' };
const KEY_B = { accessKeyId: 'AKIDB', secretAccessKey: 'sb', sessionToken: 'tb' };

/** Each chain construction resolves to the "file contents" at that moment. */
let onDisk: Record<string, unknown> = KEY_A;
let resolveCalls = 0;

beforeEach(() => {
  onDisk = KEY_A;
  resolveCalls = 0;
  mockFromNodeProviderChain.mockReset();
  mockFromNodeProviderChain.mockImplementation(() => async () => {
    resolveCalls += 1;
    return onDisk;
  });
});

describe('createRefreshingCredentialProvider', () => {
  it('builds a FRESH chain with ignoreCache (and the profile) on every refresh — never a memoised one', async () => {
    let clock = 0;
    const provider = createRefreshingCredentialProvider({ profile: 'eval', now: () => clock });
    await provider();
    clock += DEFAULT_CREDENTIAL_TTL_MS;
    await provider();
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2);
    expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'eval', ignoreCache: true });
  });

  it('omits `profile` when none is given so the chain falls back to $AWS_PROFILE / default ordering', async () => {
    await createRefreshingCredentialProvider()();
    expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ ignoreCache: true });
  });

  it('reuses credentials without an expiration inside the TTL and re-resolves the rotated key after it', async () => {
    let clock = 1_000_000;
    const provider = createRefreshingCredentialProvider({ now: () => clock });

    const first = await provider();
    expect(first).toMatchObject(KEY_A);
    expect(first.expiration?.getTime()).toBe(clock + DEFAULT_CREDENTIAL_TTL_MS);

    onDisk = KEY_B;
    clock += DEFAULT_CREDENTIAL_TTL_MS - 1;
    expect((await provider()).accessKeyId).toBe('AKIDA');
    expect(resolveCalls).toBe(1);

    clock += 1;
    const rotated = await provider();
    expect(rotated).toMatchObject(KEY_B);
    expect(rotated.expiration?.getTime()).toBe(clock + DEFAULT_CREDENTIAL_TTL_MS);
    expect(resolveCalls).toBe(2);
  });

  it('honours a custom ttlMs', async () => {
    let clock = 0;
    const provider = createRefreshingCredentialProvider({ ttlMs: 10, now: () => clock });
    await provider();
    onDisk = KEY_B;
    clock = 9;
    expect((await provider()).accessKeyId).toBe('AKIDA');
    clock = 10;
    expect((await provider()).accessKeyId).toBe('AKIDB');
  });

  it('stamps the synthetic expiration on a COPY — the object the chain handed out is not mutated', async () => {
    const shared = { ...KEY_A };
    onDisk = shared;
    const got = await createRefreshingCredentialProvider()();
    expect(got).not.toBe(shared);
    expect(got.expiration).toBeInstanceOf(Date);
    expect((shared as { expiration?: Date }).expiration).toBeUndefined();
  });

  it('coalesces concurrent calls into one chain resolution', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFromNodeProviderChain.mockImplementation(() => async () => {
      resolveCalls += 1;
      await gate;
      return onDisk;
    });
    const provider = createRefreshingCredentialProvider();
    const all = Promise.all([provider(), provider(), provider()]);
    release();
    const results = await all;
    expect(resolveCalls).toBe(1);
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('a failed refresh is not cached: the next call builds a new chain and retries', async () => {
    mockFromNodeProviderChain
      .mockImplementationOnce(() => async () => {
        throw new Error('Could not load credentials from any providers');
      })
      .mockImplementation(() => async () => KEY_B);
    const provider = createRefreshingCredentialProvider();
    await expect(provider()).rejects.toThrow('Could not load credentials from any providers');
    expect((await provider()).accessKeyId).toBe('AKIDB');
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2);
  });

  it('`{ forceRefresh: true }` drops the cache and re-resolves immediately, inside the TTL', async () => {
    let clock = 0;
    const provider = createRefreshingCredentialProvider({ now: () => clock });
    expect((await provider()).accessKeyId).toBe('AKIDA');
    onDisk = KEY_B;
    clock = 10; // well inside the TTL
    expect((await provider()).accessKeyId).toBe('AKIDA');
    const forced = await provider({ forceRefresh: true });
    expect(forced.accessKeyId).toBe('AKIDB');
    expect(forced.expiration?.getTime()).toBe(clock + DEFAULT_CREDENTIAL_TTL_MS); // new TTL starts now
    expect((await provider()).accessKeyId).toBe('AKIDB'); // and the cache holds the refreshed key
    expect(resolveCalls).toBe(2);
  });

  it('`{ forceRefresh: true }` never joins a resolution that started before the force request (it may have read the file before the rotation)', async () => {
    // The mock "reads the file" when the chain is invoked and returns that snapshot once released.
    const gates: Array<() => void> = [];
    mockFromNodeProviderChain.mockImplementation(() => async () => {
      resolveCalls += 1;
      const snapshot = onDisk;
      await new Promise<void>((release) => gates.push(release));
      return snapshot;
    });
    const provider = createRefreshingCredentialProvider();

    const flush = () => new Promise((r) => setImmediate(r));
    const plain = provider(); // in flight, read key A
    await flush();
    expect(gates).toHaveLength(1); // the read has happened (snapshot = A) and is waiting
    onDisk = KEY_B; // rotation
    const forced = provider({ forceRefresh: true }); // must NOT be satisfied by the in-flight read

    gates.shift()!(); // release the first read
    expect((await plain).accessKeyId).toBe('AKIDA');
    await flush(); // the forced resolution starts only after the first settles
    expect(gates).toHaveLength(1);
    gates.shift()!();
    expect((await forced).accessKeyId).toBe('AKIDB');
    expect(resolveCalls).toBe(2);
    expect((await provider()).accessKeyId).toBe('AKIDB'); // and the cache holds the refreshed key
  });

  describe('credentials that carry a real expiration (STS / SSO / IMDS / credential_process)', () => {
    it('keeps the source expiration and refreshes 5 minutes before it, not after the TTL', async () => {
      let clock = Date.parse('2026-06-01T00:00:00Z');
      const expiration = new Date(clock + 60 * 60_000);
      onDisk = { ...KEY_A, expiration };
      const provider = createRefreshingCredentialProvider({ now: () => clock });

      const first = await provider();
      expect(first.accessKeyId).toBe('AKIDA');
      expect(first.expiration).toBe(expiration); // real, not synthetic

      onDisk = { ...KEY_B, expiration: new Date(expiration.getTime() + 60 * 60_000) };
      clock += 30 * 60_000; // far past the TTL, still > 5 min before expiry
      expect((await provider()).accessKeyId).toBe('AKIDA');
      expect(resolveCalls).toBe(1);

      clock = expiration.getTime() - 5 * 60_000; // lead window reached
      expect((await provider()).accessKeyId).toBe('AKIDB');
      expect(resolveCalls).toBe(2);
    });

    it('never reuses credentials past their real expiry: with less than one TTL left, a fresh resolution happens at the expiry', async () => {
      let clock = Date.parse('2026-06-01T00:00:00Z');
      onDisk = { ...KEY_A, expiration: new Date(clock + 30_000) }; // 30 s left (< TTL, < lead)
      const provider = createRefreshingCredentialProvider({ now: () => clock });
      expect((await provider()).accessKeyId).toBe('AKIDA');

      onDisk = { ...KEY_B, expiration: new Date(clock + 60 * 60_000) };
      clock += 29_999;
      expect((await provider()).accessKeyId).toBe('AKIDA'); // still valid → reused
      expect(resolveCalls).toBe(1);
      clock += 1; // == expiration
      const fresh = await provider();
      expect(fresh.accessKeyId).toBe('AKIDB');
      expect(fresh.expiration!.getTime()).toBeGreaterThan(clock); // what we hand out is never already expired
      expect(resolveCalls).toBe(2);
    });

    it('an identity that is ALREADY expired when resolved is returned (nothing better exists) but never cached', async () => {
      let clock = Date.parse('2026-06-01T00:00:00Z');
      onDisk = { ...KEY_A, expiration: new Date(clock - 1) };
      const provider = createRefreshingCredentialProvider({ now: () => clock });
      expect((await provider()).accessKeyId).toBe('AKIDA');
      expect(resolveCalls).toBe(1);

      onDisk = { ...KEY_B, expiration: new Date(clock + 60 * 60_000) };
      // Same instant: a cached-and-reused expired identity would come back as A.
      expect((await provider()).accessKeyId).toBe('AKIDB');
      expect(resolveCalls).toBe(2);
      // The valid identity IS cached.
      expect((await provider()).accessKeyId).toBe('AKIDB');
      expect(resolveCalls).toBe(2);
    });

    it('does not spin on a source whose credentials are already inside the lead window: reuses them for one TTL', async () => {
      let clock = Date.parse('2026-06-01T00:00:00Z');
      onDisk = { ...KEY_A, expiration: new Date(clock + 2 * 60_000) }; // 2 min < 5 min lead
      const provider = createRefreshingCredentialProvider({ now: () => clock });
      expect((await provider()).accessKeyId).toBe('AKIDA');

      onDisk = { ...KEY_B, expiration: new Date(clock + 60 * 60_000) };
      clock += DEFAULT_CREDENTIAL_TTL_MS - 1;
      expect((await provider()).accessKeyId).toBe('AKIDA');
      expect(resolveCalls).toBe(1);
      clock += 1;
      expect((await provider()).accessKeyId).toBe('AKIDB');
    });
  });
});
