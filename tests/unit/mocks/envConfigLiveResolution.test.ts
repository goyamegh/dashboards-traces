/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the jest mock of `@/lib/config`
 * (`__mocks__/@/lib/config.ts`): its URL fields must be resolved from
 * `process.env.AH_PORT` on EVERY property access, not frozen at first
 * import. A previous version computed `BACKEND_URL` once at module scope,
 * so any suite that changed `AH_PORT` between tests without calling
 * `jest.resetModules()` (the common case — most suites just set env vars in
 * `beforeEach`) silently kept talking to whichever port was resolved on the
 * FIRST import of this mock in the whole jest worker.
 */
describe('__mocks__/@/lib/config ENV_CONFIG (AH_PORT live resolution)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reflects a change to process.env.AH_PORT between reads WITHOUT jest.resetModules()', async () => {
    delete process.env.AH_PORT;
    const { ENV_CONFIG } = await import('@/lib/config');

    expect(ENV_CONFIG.backendUrl).toBe('http://localhost:4001');
    expect(ENV_CONFIG.storageApiUrl).toBe('http://localhost:4001/api/storage');

    // Same imported module instance, no resetModules — just flip the env var.
    process.env.AH_PORT = '4316';
    expect(ENV_CONFIG.backendUrl).toBe('http://localhost:4316');
    expect(ENV_CONFIG.storageApiUrl).toBe('http://localhost:4316/api/storage');
    expect(ENV_CONFIG.judgeApiUrl).toBe('http://localhost:4316/api/judge');
    expect(ENV_CONFIG.agentProxyUrl).toBe('http://localhost:4316/api/agent');
    expect(ENV_CONFIG.openSearchProxyUrl).toBe('http://localhost:4316/api/opensearch/logs');

    // And back again — proving it isn't a one-shot invalidation either.
    process.env.AH_PORT = '9999';
    expect(ENV_CONFIG.backendUrl).toBe('http://localhost:9999');
  });

  it('two suites in the same worker with different AH_PORT never observe each other\'s port', async () => {
    // Simulates the coupling the reviewer asked to have proven, not just
    // asserted: import once, then act like two different "suites" each
    // setting their own AH_PORT before reading — as would happen across two
    // test files in one jest worker process (module registry is shared
    // unless resetModules() runs, which most integration suites never call).
    const { ENV_CONFIG } = await import('@/lib/config');

    process.env.AH_PORT = '4201';
    const suiteAUrl = ENV_CONFIG.storageApiUrl;
    expect(suiteAUrl).toBe('http://localhost:4201/api/storage');

    process.env.AH_PORT = '4202';
    const suiteBUrl = ENV_CONFIG.storageApiUrl;
    expect(suiteBUrl).toBe('http://localhost:4202/api/storage');

    expect(suiteAUrl).not.toBe(suiteBUrl);
  });
});
