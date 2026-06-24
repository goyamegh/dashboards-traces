/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive service.
 *
 * Guards the two things most likely to silently regress:
 *   1. the SYSTEM_PROMPT actually instructs the agent to hunt + report ERRORS
 *      in either/both runs (this content was lost once and re-added);
 *   2. buildUserPrompt threads each run's identity (key, runId, label) so the
 *      agent can cite spans with the correct runId.
 * Plus the exactly-2-runs guard on the public entry point.
 */

import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  generateComparisonDeepDive,
  type ComparisonRunInput,
} from '@/server/services/comparisonDeepDiveService';

describe('comparisonDeepDiveService — SYSTEM_PROMPT', () => {
  it('instructs the agent to hunt for errors in EACH run', () => {
    expect(SYSTEM_PROMPT).toMatch(/ERRORS/);
    expect(SYSTEM_PROMPT).toMatch(/hunt for failures in EACH run/i);
    // Mentions concrete error signals so the model knows what to look for.
    expect(SYSTEM_PROMPT).toMatch(/otel\.status_code=ERROR/);
    expect(SYSTEM_PROMPT).toMatch(/exception\./);
    expect(SYSTEM_PROMPT).toMatch(/failed or were retried/i);
  });

  it('requires an always-present Errors bullet covering run A, B, or both', () => {
    expect(SYSTEM_PROMPT).toMatch(/\*\*Errors\*\* bullet that is ALWAYS present/);
    expect(SYSTEM_PROMPT).toMatch(/run A, run B, or both/);
    // And an explicit per-run "no errors observed" when clean (never omitted).
    expect(SYSTEM_PROMPT).toMatch(/no errors observed/);
    expect(SYSTEM_PROMPT).toMatch(/never silently omit/i);
  });

  it('still asks for span citations + a tight markdown deep-dive', () => {
    expect(SYSTEM_PROMPT).toMatch(/span:<runId>:<spanId>/);
    expect(SYSTEM_PROMPT).toMatch(/headline verdict/i);
  });
});

describe('comparisonDeepDiveService — buildUserPrompt', () => {
  const runs: ComparisonRunInput[] = [
    {
      key: 'A',
      label: 'aos-oncall (Claude Code)',
      runId: 'subprocess-AAA',
      passFailStatus: 'passed',
      accuracy: 100,
      toolNames: ['Skill', 'mcp__builder__read_ticket'],
      durationMs: 211000,
      finalOutput: 'Root cause: protected index finding.',
    },
    {
      key: 'B',
      label: 'cp-oncall (Claude Code)',
      runId: 'subprocess-BBB',
      passFailStatus: 'failed',
      durationMs: 266000,
    },
  ];

  it('labels both runs and threads each runId for span citations', () => {
    const prompt = buildUserPrompt(runs);
    expect(prompt).toMatch(/## Run A — aos-oncall \(Claude Code\)/);
    expect(prompt).toMatch(/## Run B — cp-oncall \(Claude Code\)/);
    // The runId is explicitly surfaced "use this in span: citations".
    expect(prompt).toContain('subprocess-AAA');
    expect(prompt).toContain('subprocess-BBB');
    expect(prompt).toMatch(/use this in span: citations/i);
  });

  it('includes per-run outcome + duration context when known', () => {
    const prompt = buildUserPrompt(runs);
    expect(prompt).toMatch(/outcome: passed \(score 100\)/);
    expect(prompt).toMatch(/outcome: failed/);
    expect(prompt).toMatch(/211\.0s/);
    expect(prompt).toMatch(/266\.0s/);
  });

  it('tells the agent to inspect BOTH runs before writing', () => {
    expect(buildUserPrompt(runs)).toMatch(/query_spans \/ query_logs on BOTH/);
  });
});

describe('comparisonDeepDiveService — generateComparisonDeepDive guard', () => {
  it('rejects when not exactly 2 runs (before any SDK/model work)', async () => {
    await expect(
      generateComparisonDeepDive({ runs: [{ key: 'A', label: 'only one' }] })
    ).rejects.toThrow(/exactly 2 runs/);
    await expect(
      generateComparisonDeepDive({
        runs: [
          { key: 'A', label: 'a' },
          { key: 'B', label: 'b' },
          { key: 'C', label: 'c' },
        ],
      })
    ).rejects.toThrow(/exactly 2 runs/);
  });
});
