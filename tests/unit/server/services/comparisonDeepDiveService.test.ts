/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive service.
 *
 * Guards the things most likely to silently regress:
 *   1. the SYSTEM_PROMPT actually instructs the agent to hunt + report ERRORS
 *      in every run (this content was lost once and re-added);
 *   2. buildUserPrompt threads each run's identity (key, runId, label) so the
 *      agent can cite spans with the correct runId — for 2 AND for 3–4 runs —
 *      and prepends the deterministic context prefix when supplied.
 * Plus the 2–4-runs guard on the public entry point.
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

  it('requires an always-present Errors bullet covering every run', () => {
    expect(SYSTEM_PROMPT).toMatch(/\*\*Errors\*\* bullet that is ALWAYS present/);
    expect(SYSTEM_PROMPT).toMatch(/ANY run \(run A, run B, or both\/all\)/);
    // And an explicit per-run "no errors observed" when clean (never omitted).
    expect(SYSTEM_PROMPT).toMatch(/no errors observed/);
    expect(SYSTEM_PROMPT).toMatch(/never silently omit/i);
  });

  it('still asks for span citations + a tight markdown deep-dive', () => {
    expect(SYSTEM_PROMPT).toMatch(/span:<runId>:<spanId>/);
    expect(SYSTEM_PROMPT).toMatch(/headline verdict/i);
  });

  it('teaches the N-run tool surface: run keys and per-case drill-down', () => {
    expect(SYSTEM_PROMPT).toMatch(/"A", "B", "C", "D"/);
    expect(SYSTEM_PROMPT).toMatch(/query_spans\(\{ run, caseId\?, nameFilter\? \}\)/);
    // Deterministic prefix is authoritative — the model must not recount.
    expect(SYSTEM_PROMPT).toMatch(/TRUST those numbers/);
    expect(SYSTEM_PROMPT).toMatch(/never recount/i);
    // One global narrative, not per-pair sections.
    expect(SYSTEM_PROMPT).toMatch(/ONE tight global markdown deep-dive/);
    expect(SYSTEM_PROMPT).toMatch(/NOT per-pair sections/);
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

  it('tells the agent to inspect EVERY run before writing', () => {
    expect(buildUserPrompt(runs)).toMatch(/query_spans \/ query_logs on EVERY run \("A", "B"\)/);
  });

  it('labels a third run and lists all keys for 3-run comparisons', () => {
    const three = [...runs, { key: 'C', label: 'logos (pi)', runId: 'subprocess-CCC' }];
    const prompt = buildUserPrompt(three);
    expect(prompt).toMatch(/Compare these 3 runs/);
    expect(prompt).toMatch(/EVERY run \("A", "B", "C"\)/);
    expect(prompt).toMatch(/## Run C — logos \(pi\)/);
    expect(prompt).toContain('subprocess-CCC');
  });

  it('prepends the deterministic context prefix before the per-run sections', () => {
    const prefix = '## Shared results overview\nAgreement across 84 shared cases: 59 all-pass · 5 all-fail · 20 split';
    const prompt = buildUserPrompt(runs, prefix);
    expect(prompt).toContain(prefix);
    expect(prompt.indexOf('Shared results overview')).toBeLessThan(prompt.indexOf('## Run A'));
    // Without a prefix the prompt is unchanged in shape.
    expect(buildUserPrompt(runs)).not.toContain('Shared results overview');
  });
});

describe('comparisonDeepDiveService — generateComparisonDeepDive guard', () => {
  it('rejects fewer than 2 or more than 4 runs (before any SDK/model work)', async () => {
    await expect(
      generateComparisonDeepDive({ runs: [{ key: 'A', label: 'only one' }] })
    ).rejects.toThrow(/2-4 runs/);
    await expect(
      generateComparisonDeepDive({
        runs: ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, label: key.toLowerCase() })),
      })
    ).rejects.toThrow(/2-4 runs/);
  });
});
