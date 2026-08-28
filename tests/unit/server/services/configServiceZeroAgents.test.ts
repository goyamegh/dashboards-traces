/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real unit tests for configService.ts's getConfigStatus() warnings/A6
 * behavior — calling the ACTUAL function, not the manual mock.
 *
 * jest.config.cjs's moduleNameMapper unconditionally redirects
 * `@/server/services/configService` (and the two `../.../configService.js`
 * relative shapes used by its own callers) to
 * `__mocks__/@/server/services/configService.ts`, because a past version of
 * this module (or a transitive dependency) used `import.meta.url` in a way
 * ts-jest's CJS-oriented transform couldn't handle — see that mock file's
 * header comment and tests/unit/server/services/configService.test.ts's.
 * As of this file's writing, `server/services/configService.ts` itself
 * contains no `import.meta.url` reference, and the moduleNameMapper only
 * matches an EXACT `@/server/services/configService` specifier or a
 * `../services/configService.js` / `../../services/configService.js`
 * relative shape (one or two `../` segments) — so importing via a deeper
 * relative path (four `../` segments from this file's directory) resolves
 * straight to the real module, bypassing the redirect entirely. If the
 * mapper's patterns are ever broadened (e.g. to a bare substring match),
 * this file would start hitting the mock and its assertions below would
 * need `jest.mock(...)`-style adjustment or a different bypass.
 */

describe('configService.getConfigStatus — zero-agents warning (A6, real function)', () => {
  let getConfigStatus: (agents?: any[]) => { warnings?: string[] };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ getConfigStatus } = require('../../../../server/services/configService'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('includes a zero-agents warning in the response when agents is an empty array', () => {
    const status = getConfigStatus([]);
    expect(status.warnings).toBeDefined();
    expect(status.warnings?.some((w) => w.includes('zero agents'))).toBe(true);
  });

  it('omits warnings entirely when agents is a non-empty array', () => {
    const status = getConfigStatus([{ key: 'demo', name: 'Demo Agent' }] as any);
    expect(status.warnings).toBeUndefined();
  });

  it('omits warnings entirely when agents is undefined (caller did not pass config)', () => {
    const status = getConfigStatus(undefined);
    expect(status.warnings).toBeUndefined();
  });

  it('logs the zero-agents warning to the server console on the first call', () => {
    getConfigStatus([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('zero agents');
  });

  it('does NOT re-log on a second zero-agents call in the same process (warn-once)', () => {
    // Regression for a codex_review finding: GET /api/storage/config/status
    // is polled by the UI (Dashboard's useDataState, SettingsPage) on every
    // page visit, not just once at server startup — without the warn-once
    // guard, a persistent zero-agents config would spam this line on every
    // request. The returned `warnings` field itself must stay live on every
    // call (asserted above); only the console.warn is deduplicated.
    getConfigStatus([]);
    getConfigStatus([]);
    getConfigStatus([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('still returns warnings on every call even after the console.warn has already fired once', () => {
    getConfigStatus([]);
    const second = getConfigStatus([]);
    expect(second.warnings?.some((w) => w.includes('zero agents'))).toBe(true);
  });
});
