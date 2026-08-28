/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isFilePath, deriveUnifiedRunName } from '@/cli/utils/runNaming';

describe('isFilePath', () => {
  it('treats .json paths as files', () => {
    expect(isFilePath('test-cases.json')).toBe(true);
    expect(isFilePath('./data/TEST-CASES.JSON')).toBe(true);
  });

  it('treats code eval files as files', () => {
    expect(isFilePath('redkite-cost.eval.js')).toBe(true);
    expect(isFilePath('suite.eval.ts')).toBe(true);
    expect(isFilePath('suite.mjs')).toBe(true);
  });

  it('treats plain names as benchmark names, not files', () => {
    expect(isFilePath('My Benchmark')).toBe(false);
    expect(isFilePath('autoresearch-redkite')).toBe(false);
    expect(isFilePath('bench-123456')).toBe(false);
  });
});

describe('deriveUnifiedRunName', () => {
  const now = new Date('2026-02-14T10:30:00.000Z');

  it('prefixes the run name with -n when it is a real benchmark name (the dogfood bug)', () => {
    // Regression: `benchmark -f redkite-cost.eval.js -n "autoresearch-redkite" -a cc-redkite`
    // used to name the run "CLI Run - cc-redkite - <ISO>" regardless of -n,
    // making it undiscoverable in the runs list even though the benchmark
    // it belonged to was named clearly.
    expect(deriveUnifiedRunName('autoresearch-redkite', 'cc-redkite', now))
      .toBe('autoresearch-redkite — 2026-02-14T10:30:00.000Z');
  });

  it('falls back to the generic CLI Run name when no -n is given', () => {
    expect(deriveUnifiedRunName(undefined, 'cc-redkite', now))
      .toBe('CLI Run - cc-redkite - 2026-02-14T10:30:00.000Z');
  });

  it('falls back to the generic CLI Run name when -n is empty string', () => {
    expect(deriveUnifiedRunName('', 'cc-redkite', now))
      .toBe('CLI Run - cc-redkite - 2026-02-14T10:30:00.000Z');
  });

  it('falls back to the generic CLI Run name when -n looks like a legacy file path', () => {
    // `-n ./test-cases.json` is the legacy single-file mode overload — not a
    // real benchmark name, so it must not become the run name prefix.
    expect(deriveUnifiedRunName('./test-cases.json', 'mock', now))
      .toBe('CLI Run - mock - 2026-02-14T10:30:00.000Z');
  });

  it('defaults `now` to the current time when omitted', () => {
    const name = deriveUnifiedRunName('My Benchmark', 'agent-a');
    expect(name).toMatch(/^My Benchmark — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
