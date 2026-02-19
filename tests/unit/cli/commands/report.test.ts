/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the report CLI command.
 *
 * Note: The main command action has complex dependencies (server lifecycle, ora spinners,
 * network calls) that are better tested through integration tests. These unit tests focus
 * on the command configuration by mocking all external dependencies.
 */

// Mock dependencies before imports (jest.mock is hoisted)
jest.mock('@/lib/config/index', () => ({
  loadConfig: jest.fn().mockResolvedValue({ server: {}, agents: [] }),
  DEFAULT_SERVER_CONFIG: { port: 4001 },
}));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: jest.fn().mockResolvedValue({ baseUrl: 'http://localhost:4001', wasStarted: false }),
  createServerCleanup: jest.fn().mockReturnValue(jest.fn()),
}));

jest.mock('@/cli/utils/apiClient', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    findBenchmark: jest.fn(),
  })),
}));

jest.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
  cyan: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  gray: (s: string) => s,
  bold: (s: string) => s,
}));

jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
  }));
});

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
}));

import { createReportCommand } from '@/cli/commands/report';

describe('Report Command', () => {
  describe('command configuration', () => {
    it('should have name "report"', () => {
      const command = createReportCommand();
      expect(command.name()).toBe('report');
    });

    it('should have a description', () => {
      const command = createReportCommand();
      expect(command.description()).toContain('report');
    });

    it('should require --benchmark option', () => {
      const command = createReportCommand();
      const benchmarkOption = command.options.find(
        (o) => o.long === '--benchmark'
      );
      expect(benchmarkOption).toBeDefined();
      expect(benchmarkOption!.mandatory).toBe(true);
    });

    it('should have --format option with default "html"', () => {
      const command = createReportCommand();
      const formatOption = command.options.find(
        (o) => o.long === '--format'
      );
      expect(formatOption).toBeDefined();
      expect(formatOption!.defaultValue).toBe('html');
    });

    it('should have optional --runs option', () => {
      const command = createReportCommand();
      const runsOption = command.options.find(
        (o) => o.long === '--runs'
      );
      expect(runsOption).toBeDefined();
      expect(runsOption!.mandatory).toBeFalsy();
    });

    it('should have optional --output option', () => {
      const command = createReportCommand();
      const outputOption = command.options.find(
        (o) => o.long === '--output'
      );
      expect(outputOption).toBeDefined();
    });

    it('should have --stdout flag', () => {
      const command = createReportCommand();
      const stdoutOption = command.options.find(
        (o) => o.long === '--stdout'
      );
      expect(stdoutOption).toBeDefined();
    });
  });
});
