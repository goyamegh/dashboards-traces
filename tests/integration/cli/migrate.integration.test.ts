/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the CLI migrate command.
 *
 * Since computeStatsFromReports is not exported, we test the command's
 * interaction with the API by mocking global.fetch and verifying the
 * stats computation logic through the command's network calls.
 */

import { createMigrateCommand } from '@/cli/commands/migrate';
import type { Benchmark, BenchmarkRun, EvaluationReport } from '@/types/index';

// Mock dependencies that require server access or produce side effects
jest.mock('@/lib/config/index', () => ({
  loadConfig: jest.fn().mockResolvedValue({
    server: { port: 4001, reuseExistingServer: true },
  }),
}));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: jest.fn().mockResolvedValue({ baseUrl: 'http://localhost:4001' }),
  createServerCleanup: jest.fn().mockReturnValue(() => {}),
}));

jest.mock('ora', () => {
  return jest.fn().mockReturnValue({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
  });
});

jest.mock('chalk', () => {
  const identity = (s: string) => s;
  const chainable: any = new Proxy(identity, {
    get: () => chainable,
    apply: (_target: any, _thisArg: any, args: any[]) => args[0],
  });
  return { __esModule: true, default: chainable };
});

describe('CLI Migrate Command', () => {
  let originalFetch: typeof global.fetch;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];

  beforeEach(() => {
    originalFetch = global.fetch;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;
    consoleOutput = [];
    console.log = jest.fn((...args) => consoleOutput.push(args.join(' ')));
    console.error = jest.fn((...args) => consoleOutput.push(args.join(' ')));
    process.exit = jest.fn() as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  });

  describe('command structure', () => {
    it('should create a command named "migrate"', () => {
      const cmd = createMigrateCommand();
      expect(cmd.name()).toBe('migrate');
    });

    it('should have --dry-run option', () => {
      const cmd = createMigrateCommand();
      const dryRunOption = cmd.options.find(o => o.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });

    it('should have --verbose option', () => {
      const cmd = createMigrateCommand();
      const verboseOption = cmd.options.find(o => o.long === '--verbose');
      expect(verboseOption).toBeDefined();
    });

    it('should have evaluation-runs subcommand', () => {
      const cmd = createMigrateCommand();
      const subCmd = cmd.commands.find(c => c.name() === 'evaluation-runs');
      expect(subCmd).toBeDefined();
    });

    it('should have --dry-run option on evaluation-runs subcommand', () => {
      const cmd = createMigrateCommand();
      const subCmd = cmd.commands.find(c => c.name() === 'evaluation-runs');
      const dryRunOption = subCmd?.options.find(o => o.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });
  });

  describe('stats computation via dry-run', () => {
    function makeBenchmark(id: string, runs: Partial<BenchmarkRun>[]): Benchmark {
      return {
        id,
        name: `Benchmark ${id}`,
        description: '',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: runs.map(r => ({
          id: r.id || 'run-1',
          name: r.name || 'Run 1',
          createdAt: '2025-01-01T00:00:00Z',
          agentKey: 'demo',
          modelId: 'test-model',
          results: r.results || {},
          ...r,
        })) as BenchmarkRun[],
      };
    }

    function makeReport(id: string, passFailStatus: string, metricsStatus?: string): Partial<EvaluationReport> {
      return {
        id,
        timestamp: '2025-01-01T00:00:00Z',
        testCaseId: 'tc-1',
        agentName: 'Demo',
        modelName: 'Test',
        status: 'completed',
        passFailStatus: passFailStatus as any,
        metricsStatus: metricsStatus as any,
        trajectory: [],
        metrics: { accuracy: 0.8 } as any,
        llmJudgeReasoning: 'test',
      };
    }

    function setupFetchMock(benchmarks: Benchmark[], reportsMap: Record<string, any[]>) {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/storage/benchmarks') && !url.includes('/runs/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ benchmarks }),
          });
        }
        if (typeof url === 'string' && url.includes('/api/storage/runs/by-benchmark-run/')) {
          // Extract benchmark and run ID from URL
          const parts = url.split('/');
          const runId = parts[parts.length - 1];
          const benchmarkId = parts[parts.length - 2];
          const key = `${benchmarkId}/${runId}`;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ runs: reportsMap[key] || [] }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    }

    it('should compute stats with all reports passed', async () => {
      const benchmark = makeBenchmark('bench-1', [{
        id: 'run-1',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      }]);

      setupFetchMock([benchmark], {
        'bench-1/run-1': [
          makeReport('report-1', 'passed'),
          makeReport('report-2', 'passed'),
          makeReport('report-3', 'passed'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      // In dry-run + verbose, the command logs stats per run
      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=3');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=0');
    });

    it('should compute stats with mixed results', async () => {
      const benchmark = makeBenchmark('bench-2', [{
        id: 'run-2',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'failed' },
        },
      }]);

      setupFetchMock([benchmark], {
        'bench-2/run-2': [
          makeReport('report-1', 'passed'),
          makeReport('report-2', 'failed'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=1');
      expect(statsLine).toContain('failed=2'); // report-2 failed + tc-3 execution failed
      expect(statsLine).toContain('pending=0');
    });

    it('should count metricsStatus pending as pending even if result is completed', async () => {
      const benchmark = makeBenchmark('bench-3', [{
        id: 'run-3',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      }]);

      setupFetchMock([benchmark], {
        'bench-3/run-3': [
          makeReport('report-1', 'passed'),
          makeReport('report-2', 'passed', 'pending'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=1');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=1');
    });

    it('should count missing reports as pending', async () => {
      const benchmark = makeBenchmark('bench-4', [{
        id: 'run-4',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-missing', status: 'completed' },
        },
      }]);

      // Only return report-1, report-missing is not in the response
      setupFetchMock([benchmark], {
        'bench-4/run-4': [
          makeReport('report-1', 'passed'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=1');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=1');
    });

    it('should handle empty results with zero counts', async () => {
      const benchmark = makeBenchmark('bench-5', [{
        id: 'run-5',
        results: {},
      }]);

      setupFetchMock([benchmark], {
        'bench-5/run-5': [],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=0');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=0');
    });

    it('should count result with status pending as pending', async () => {
      const benchmark = makeBenchmark('bench-6', [{
        id: 'run-6',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'pending' },
          'tc-3': { reportId: '', status: 'running' },
        },
      }]);

      setupFetchMock([benchmark], {
        'bench-6/run-6': [
          makeReport('report-1', 'passed'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=1');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=2');
    });

    it('should count metricsStatus calculating as pending', async () => {
      const benchmark = makeBenchmark('bench-7', [{
        id: 'run-7',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      }]);

      setupFetchMock([benchmark], {
        'bench-7/run-7': [
          makeReport('report-1', 'passed', 'calculating'),
        ],
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      const statsLine = consoleOutput.find(l => l.includes('passed='));
      expect(statsLine).toContain('passed=0');
      expect(statsLine).toContain('failed=0');
      expect(statsLine).toContain('pending=1');
    });

    it('should skip runs that already have stats', async () => {
      const benchmark = makeBenchmark('bench-8', [{
        id: 'run-8',
        stats: { passed: 2, failed: 1, pending: 0, total: 3 },
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      }]);

      setupFetchMock([benchmark], {});

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      // Should indicate it was already done
      const alreadyLine = consoleOutput.find(l => l.includes('already has stats'));
      expect(alreadyLine).toBeDefined();
    });

    it('should skip demo benchmarks', async () => {
      const benchmark = makeBenchmark('demo-benchmark', [{
        id: 'run-demo',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      }]);

      setupFetchMock([benchmark], {});

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      // Should report nothing to migrate
      const noMigrateLine = consoleOutput.find(l => l.includes('No benchmarks to migrate'));
      expect(noMigrateLine).toBeDefined();
    });

    it('should handle fetch errors gracefully and count as errors', async () => {
      const benchmark = makeBenchmark('bench-9', [{
        id: 'run-9',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      }]);

      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/storage/benchmarks') && !url.includes('/runs/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ benchmarks: [benchmark] }),
          });
        }
        if (typeof url === 'string' && url.includes('/api/storage/runs/by-benchmark-run/')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run', '--verbose']);

      // Should show error in output
      const errorLine = consoleOutput.find(l => l.includes('Errors:'));
      expect(errorLine).toBeDefined();
    });
  });

  describe('ApiClient integration for listBenchmarks', () => {
    it('should call /api/storage/benchmarks endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ benchmarks: [] }),
      });
      global.fetch = fetchMock;

      const cmd = createMigrateCommand();
      await cmd.parseAsync(['node', 'test', '--dry-run']);

      // Verify that the benchmarks endpoint was called
      const calls = fetchMock.mock.calls.map(c => c[0]);
      const benchmarkCall = calls.find((url: string) =>
        typeof url === 'string' && url.includes('/api/storage/benchmarks')
      );
      expect(benchmarkCall).toBeDefined();
    });
  });
});
