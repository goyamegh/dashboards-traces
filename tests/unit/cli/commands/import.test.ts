/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the import CLI command.
 */

jest.mock('chalk', () => ({
  default: {
    cyan: Object.assign((s: string) => s, { bold: (s: string) => s }),
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
  cyan: Object.assign((s: string) => s, { bold: (s: string) => s }),
  green: Object.assign((s: string) => s, { bold: (s: string) => s }),
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
    text: '',
  }));
});

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
}));

jest.mock('@/cli/converters/index', () => ({
  convertAllFromLocal: jest.fn(),
  convertAllFromGitHub: jest.fn(),
}));

import { createImportCommand } from '@/cli/commands/import';
import { convertAllFromLocal, convertAllFromGitHub } from '@/cli/converters/index';
import { writeFileSync } from 'fs';

const mockConvertLocal = convertAllFromLocal as jest.MockedFunction<typeof convertAllFromLocal>;
const mockConvertGitHub = convertAllFromGitHub as jest.MockedFunction<typeof convertAllFromGitHub>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;

describe('createImportCommand', () => {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exit = jest.fn() as any;
    console.log = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  it('creates a command named "import"', () => {
    const cmd = createImportCommand();
    expect(cmd.name()).toBe('import');
  });

  it('has required --from option', () => {
    const cmd = createImportCommand();
    const fromOpt = cmd.options.find((o) => o.long === '--from');
    expect(fromOpt).toBeDefined();
    expect(fromOpt!.required).toBe(true);
  });

  it('has optional --source, --output, --dry-run options', () => {
    const cmd = createImportCommand();
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--source');
    expect(optionNames).toContain('--output');
    expect(optionNames).toContain('--dry-run');
  });

  it('rejects unsupported format', async () => {
    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'unknown']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unsupported format'));
  });

  it('uses local converter when --source is provided', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/some/path']);

    expect(mockConvertLocal).toHaveBeenCalledWith('/some/path');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('uses GitHub converter when --source is omitted', async () => {
    mockConvertGitHub.mockResolvedValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt']);

    expect(mockConvertGitHub).toHaveBeenCalledWith('robusta-dev/holmesgpt', 'master', expect.any(Function));
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('does not write files in dry-run mode', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path', '--dry-run']);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('defaults output to holmesgpt-test-cases.json', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'test',
          description: 'Test',
          category: 'General',
          difficulty: 'Medium',
          initialPrompt: 'test',
          expectedOutcomes: ['result'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      'holmesgpt-test-cases.json',
      expect.any(String),
      'utf-8'
    );
  });

  it('respects custom --output path', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'test',
          description: 'Test',
          category: 'General',
          difficulty: 'Medium',
          initialPrompt: 'test',
          expectedOutcomes: ['result'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path', '-o', 'custom.json']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      'custom.json',
      expect.any(String),
      'utf-8'
    );
  });
});
