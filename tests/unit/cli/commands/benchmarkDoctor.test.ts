/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `benchmark doctor` CLI command wrapper
 * (cli/commands/benchmarkDoctor.ts).
 *
 * services/benchmarkDoctor.ts (the plan-building logic) already has its own
 * dedicated unit + integration tests. This file exercises the CLI wiring
 * around it: option parsing, server lifecycle, human-readable report
 * printing (dry-run / apply / migrate-images / error branches), and the
 * `--json` output shape — all with the server lifecycle, ApiClient, and
 * service functions mocked.
 */

jest.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalkMock = {
    bold: identity,
    gray: identity,
    yellow: identity,
    white: identity,
    cyan: identity,
    green: identity,
    red: identity,
  };
  return { default: chalkMock, ...chalkMock };
});

jest.mock('@/lib/config/index', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: jest.fn(),
  createServerCleanup: jest.fn(),
}));

jest.mock('@/cli/utils/apiClient', () => ({
  ApiClient: jest.fn(),
}));

jest.mock('@/services/benchmarkDoctor', () => ({
  buildDoctorPlan: jest.fn(),
  applyDoctorPlan: jest.fn(),
  migrateBenchmarksToImages: jest.fn(),
}));

import { createBenchmarkDoctorCommand } from '@/cli/commands/benchmarkDoctor';
import { loadConfig } from '@/lib/config/index';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle';
import { ApiClient } from '@/cli/utils/apiClient';
import {
  buildDoctorPlan,
  applyDoctorPlan,
  migrateBenchmarksToImages,
} from '@/services/benchmarkDoctor';

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockEnsureServer = ensureServer as jest.MockedFunction<typeof ensureServer>;
const mockCreateServerCleanup = createServerCleanup as jest.MockedFunction<typeof createServerCleanup>;
const MockApiClient = ApiClient as unknown as jest.Mock;
const mockBuildDoctorPlan = buildDoctorPlan as jest.MockedFunction<typeof buildDoctorPlan>;
const mockApplyDoctorPlan = applyDoctorPlan as jest.MockedFunction<typeof applyDoctorPlan>;
const mockMigrate = migrateBenchmarksToImages as jest.MockedFunction<typeof migrateBenchmarksToImages>;

const emptyPlan = {
  summary: { totalBenchmarks: 3, debrisCount: 0, husksToMerge: 0, runsToRepoint: 0 },
  debrisDeletions: [],
  contentDupGroups: [],
};

const busyPlan = {
  summary: { totalBenchmarks: 5, debrisCount: 1, husksToMerge: 1, runsToRepoint: 2 },
  debrisDeletions: [
    { id: 'bench-debris-1', name: 'quick-123', reason: 'timestamped debris, no runs, >24h old' },
  ],
  contentDupGroups: [
    {
      canonicalId: 'bench-canonical',
      canonicalName: 'My Benchmark',
      husks: [{ id: 'bench-husk', name: 'My Benchmark (copy)', embeddedRunCount: 2 }],
      runRepoints: [{ id: 'run-1' }, { id: 'run-2' }],
    },
  ],
};

describe('createBenchmarkDoctorCommand', () => {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  let listBenchmarksMock: jest.Mock;
  let listEvaluationRunsMock: jest.Mock;
  let cleanupMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exit = jest.fn() as any;
    console.log = jest.fn();
    console.error = jest.fn();

    mockLoadConfig.mockResolvedValue({ server: {} } as any);
    mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4001' } as any);
    cleanupMock = jest.fn();
    mockCreateServerCleanup.mockReturnValue(cleanupMock);

    listBenchmarksMock = jest.fn().mockResolvedValue([]);
    listEvaluationRunsMock = jest.fn().mockResolvedValue([]);
    MockApiClient.mockImplementation(() => ({
      listBenchmarks: listBenchmarksMock,
      listEvaluationRuns: listEvaluationRunsMock,
    }));

    mockBuildDoctorPlan.mockReturnValue(emptyPlan as any);
    mockApplyDoctorPlan.mockResolvedValue({
      debrisDeleted: 0,
      husksDeleted: 0,
      runsRepointed: 0,
      embeddedRunsMerged: 0,
      errors: [],
    } as any);
    mockMigrate.mockResolvedValue({ migrated: [], skipped: [], errors: [] } as any);
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  it('creates a "doctor" subcommand with --apply, --migrate-images, --json options', () => {
    const cmd = createBenchmarkDoctorCommand();
    expect(cmd.name()).toBe('doctor');
    const names = cmd.options.map((o) => o.long);
    expect(names).toEqual(expect.arrayContaining(['--apply', '--migrate-images', '--json']));
  });

  it('dry-run with no debris/dups: sets readOnly, prints the "nothing to do" report', async () => {
    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor']);

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockEnsureServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(listBenchmarksMock).toHaveBeenCalled();
    expect(listEvaluationRunsMock).toHaveBeenCalledWith({ size: 1000 });
    expect(mockBuildDoctorPlan).toHaveBeenCalled();
    expect(mockApplyDoctorPlan).not.toHaveBeenCalled();
    expect(mockMigrate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No debris or content duplicates found'));
    expect(cleanupMock).toHaveBeenCalled();
  });

  it('dry-run with debris/dups: prints plan details and the "re-run with --apply" hint', async () => {
    mockBuildDoctorPlan.mockReturnValue(busyPlan as any);
    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor']);

    const output = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Debris to delete (1)');
    expect(output).toContain('quick-123');
    expect(output).toContain('Content-duplicate groups (1)');
    expect(output).toContain('My Benchmark');
    expect(output).toContain('re-point 2 eval-run(s)');
    expect(output).toContain('Dry-run only. Re-run with --apply to execute.');
  });

  it('--apply: sets readOnly=false, applies the plan and prints a summary + errors', async () => {
    mockBuildDoctorPlan.mockReturnValue(busyPlan as any);
    mockApplyDoctorPlan.mockResolvedValue({
      debrisDeleted: 1,
      husksDeleted: 1,
      runsRepointed: 2,
      embeddedRunsMerged: 2,
      errors: ['failed to delete bench-x'],
    } as any);

    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor', '--apply']);

    expect(mockEnsureServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    expect(mockApplyDoctorPlan).toHaveBeenCalledWith(expect.anything(), busyPlan);
    const output = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Applied: 1 debris deleted, 1 husks merged+deleted, 2 runs re-pointed, 2 embedded runs merged.');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('failed to delete bench-x'));
  });

  it('--migrate-images (no --apply): dry-run preview only — readOnly stays true, no writes, prints a plan', async () => {
    mockMigrate.mockResolvedValue({
      dryRun: true,
      migrated: [
        { name: 'Bench A', digest: 'abcdef1234567890', alreadyExists: false },
        { name: 'Bench D', digest: '0011223344556677', alreadyExists: true },
      ],
      skipped: [{ name: 'Bench B', reason: 'no test cases' }],
      errors: ['image build failed for Bench C'],
    } as any);

    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor', '--migrate-images']);

    // --migrate-images alone must NOT force a mutating (non-read-only)
    // server connection — it's a preview now, same as bare `doctor`.
    expect(mockEnsureServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(mockMigrate).toHaveBeenCalledWith(expect.anything(), 'http://localhost:4001', { dryRun: true });
    const output = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Image migration plan (dry-run):');
    expect(output).toContain('Bench A');
    expect(output).toContain('abcdef123456');
    expect(output).toContain('would create');
    expect(output).toContain('Bench D');
    expect(output).toContain('already an image');
    expect(output).toContain('Bench B: skipped (no test cases)');
    expect(output).toContain('image build failed for Bench C');
    expect(output).toContain('Dry-run only. Re-run with --migrate-images --apply to execute.');
  });

  it('--migrate-images --apply: executes the migration — readOnly=false, prints executed (not preview) lines', async () => {
    mockMigrate.mockResolvedValue({
      dryRun: false,
      migrated: [{ name: 'Bench A', digest: 'abcdef1234567890' }],
      skipped: [{ name: 'Bench B', reason: 'no test cases' }],
      errors: [],
    } as any);

    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor', '--migrate-images', '--apply']);

    expect(mockEnsureServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    expect(mockMigrate).toHaveBeenCalledWith(expect.anything(), 'http://localhost:4001', { dryRun: false });
    const output = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Image migration:');
    expect(output).not.toContain('Image migration plan (dry-run):');
    expect(output).not.toContain('Dry-run only. Re-run with --migrate-images --apply');
    expect(output).toContain('Bench A');
  });

  it('--json with --apply and --migrate-images: prints one JSON document containing plan/result/migration', async () => {
    mockBuildDoctorPlan.mockReturnValue(busyPlan as any);
    mockApplyDoctorPlan.mockResolvedValue({
      debrisDeleted: 1, husksDeleted: 1, runsRepointed: 2, embeddedRunsMerged: 2, errors: [],
    } as any);
    mockMigrate.mockResolvedValue({ dryRun: false, migrated: [], skipped: [], errors: [] } as any);

    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor', '--apply', '--migrate-images', '--json']);

    // printPlan() must NOT run in json mode.
    const output = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).not.toContain('Benchmark Doctor — plan');

    const jsonCall = (console.log as jest.Mock).mock.calls.find((c) => {
      try { JSON.parse(c[0]); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.plan).toEqual(busyPlan);
    expect(parsed.result.debrisDeleted).toBe(1);
    expect(parsed.migration).toEqual({ dryRun: false, migrated: [], skipped: [], errors: [] });
  });

  it('prints an error and exits 1 when the API call throws, but still cleans up', async () => {
    listBenchmarksMock.mockRejectedValue(new Error('boom'));

    const cmd = createBenchmarkDoctorCommand();
    await cmd.parseAsync(['node', 'doctor']);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error: boom'));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(cleanupMock).toHaveBeenCalled();
  });
});
