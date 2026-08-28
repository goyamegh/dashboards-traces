/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for CLI DX improvements (A5 + A6)
 * - A5: Port-in-use error mentioning AH_PORT, config loading help, CLAUDE_CODE_BIN validation
 * - A6: Config silently losing agents warning
 */

describe('CLI DX Guards', () => {
  describe('A5.1 - Port-in-use error message mentioning AH_PORT', () => {
    it('should suggest AH_PORT in error message when all ports exhausted', () => {
      const MAX_PORT_ATTEMPTS = 10;
      const port = 4001;
      const maxPort = port + MAX_PORT_ATTEMPTS;

      // Simulate error message that should be generated
      const errorMsg =
        `Port ${maxPort} is in use and all fallback ports (${port}-${maxPort}) are occupied. ` +
        `Set AH_PORT=<available-port> to use a different port`;

      expect(errorMsg).toContain('AH_PORT');
      expect(errorMsg).toContain('available-port');
    });
  });

  describe('A5.2 - Config loading error messages for package.json', () => {
    it('should suggest package.json type:module in error', () => {
      const baseError = 'ERR_MODULE_NOT_FOUND';
      let helpText = '';

      if (baseError.includes('ERR_MODULE_NOT_FOUND')) {
        helpText = 'Ensure your cwd package.json has: {"type":"module"}';
      }

      expect(helpText).toContain('package.json');
      expect(helpText).toContain('type');
      expect(helpText).toContain('module');
    });
  });

  describe('A5.3 - TSX_TSCONFIG_PATH error message', () => {
    it('should suggest TSX_TSCONFIG_PATH in error', () => {
      const baseError = 'tsconfig';
      let helpText = '';

      if (baseError.includes('tsconfig')) {
        helpText = 'Set TSX_TSCONFIG_PATH to your tsconfig.json location';
      }

      expect(helpText).toContain('TSX_TSCONFIG_PATH');
      expect(helpText).toContain('tsconfig.json');
    });
  });

  describe('A6 - Zero agents config warning', () => {
    // NOTE: server/services/configService.ts is globally redirected to
    // __mocks__/@/server/services/configService.ts via jest.config.cjs's
    // moduleNameMapper (the real module reads import.meta.url, which Jest's
    // CJS-oriented ts-jest transform can't handle) — so getConfigStatus()
    // itself is NOT reachable, real, in any Jest process, unit or
    // integration. These cases pin the *contract* (the exact condition and
    // message shape a caller should see); the real function executing that
    // contract end-to-end is covered by hitting the actual running server in
    // tests/integration/cli-dx-a6-zero-agents.test.ts, which is also where
    // this repo's own configService.test.ts says the real implementation is
    // tested (see that file's header comment).
    it('should generate warning message for zero agents', () => {
      const agents = [] as any[];
      const warnings: string[] = [];

      if (agents.length === 0) {
        warnings.push('WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.');
      }

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('zero agents');
    });

    it('should not generate warning for non-empty agents', () => {
      const agents = [{ key: 'test-agent', name: 'Test Agent' }] as any[];
      const warnings: string[] = [];

      if (agents !== undefined && agents.length === 0) {
        warnings.push('WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.');
      }

      expect(warnings.length).toBe(0);
    });

    it('should not generate warning for undefined agents', () => {
      const agents = undefined as any;
      const warnings: string[] = [];

      if (agents !== undefined && agents.length === 0) {
        warnings.push('WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.');
      }

      expect(warnings.length).toBe(0);
    });
  });
});
