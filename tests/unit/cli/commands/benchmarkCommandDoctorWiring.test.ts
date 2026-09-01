/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit test for the tiny addition to `createBenchmarkCommand()`: it now
 * registers `benchmark doctor` (createBenchmarkDoctorCommand()) as a
 * subcommand of `benchmark`.
 */

jest.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalkMock = {
    cyan: identity, green: identity, yellow: identity, red: identity, gray: identity, bold: identity, white: identity,
  };
  return { default: chalkMock, ...chalkMock };
});

jest.mock('ora', () => jest.fn(() => ({
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  stop: jest.fn().mockReturnThis(),
  text: '',
})));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: jest.fn(),
  createServerCleanup: jest.fn(),
  isServerRunning: jest.fn(),
}));

import { createBenchmarkCommand } from '@/cli/commands/benchmark';

describe('createBenchmarkCommand — doctor subcommand wiring', () => {
  it('registers "doctor" as a subcommand of "benchmark"', () => {
    const cmd = createBenchmarkCommand();
    const subcommandNames = cmd.commands.map((c) => c.name());
    expect(subcommandNames).toContain('doctor');
  });

  it('the registered doctor subcommand is the one from benchmarkDoctor.ts', () => {
    const cmd = createBenchmarkCommand();
    const doctor = cmd.commands.find((c) => c.name() === 'doctor');
    expect(doctor).toBeDefined();
    expect(doctor!.description()).toContain('Detect and clean up');
  });
});
