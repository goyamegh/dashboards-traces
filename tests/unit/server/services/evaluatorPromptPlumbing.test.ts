/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-service tests pinning the evaluator-prompt-plumbing contract.
 *
 * Each test mocks the spawn / SDK at the lowest layer and asserts that the
 * saved evaluator's `systemPrompt` actually reaches the model AND that the
 * evaluator's `scoringConfig.metrics` drives parsed-metric extraction.
 *
 * These tests exist specifically to prevent a regression of the silent-prompt-drop
 * bug fixed by the evaluator-prompt-plumbing change: pre-fix, /api/judge
 * loaded the saved evaluator from storage but the claude-code / pi / agent /
 * agentic services threw it away and used hardcoded JUDGE_SYSTEM_PROMPT and
 * the legacy 4-metric schema. Each test below names the contract it pins
 * so a future refactor breaks loudly with a clear message.
 */

import type { Evaluator } from '@/types';

// Minimal evaluator stub that exercises BOTH halves of the contract:
//   - a custom systemPrompt that must be forwarded to the model verbatim
//   - a custom metric name that must be honored in the parsed response
function makeCustomEvaluator(overrides: Partial<Evaluator> = {}): Evaluator {
  return {
    id: 'eval-cp-oncall',
    name: 'CP-Oncall judge',
    description: '',
    isSystem: false,
    systemPrompt:
      'You are the CP-Oncall judge. Emit ONLY this JSON: ' +
      '{"pass_fail_status":"passed|failed","reasoning":"...","custom_score":<0-100>}',
    scoringConfig: {
      metrics: [{ name: 'custom_score', description: '', weight: 1, scale: 100 }],
      passThreshold: 70,
      scale: 100,
    },
    inferenceConfig: {},
    ...overrides,
  } as unknown as Evaluator;
}

// ---------------------------------------------------------------------------
// claude-code provider
// ---------------------------------------------------------------------------

describe('claudeCodeJudgeService — evaluator wiring', () => {
  let capturedSystemPrompt: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    capturedSystemPrompt = undefined;

    // Mock child_process.spawn so we can intercept --append-system-prompt.
    // The closest captured arg becomes our assertion target. The fake
    // process emits the JSON shape Claude Code's --print mode uses
    // ({ result: '...' }) so the parser path runs end-to-end.
    jest.doMock('child_process', () => ({
      spawn: jest.fn((_cmd: string, args: string[]) => {
        const idx = args.indexOf('--append-system-prompt');
        capturedSystemPrompt = idx >= 0 ? args[idx + 1] : undefined;
        const handlers: Record<string, Function[]> = {};
        const child: any = {
          stdout: {
            on: (ev: string, fn: Function) => {
              (handlers[`stdout.${ev}`] ||= []).push(fn);
            },
          },
          stderr: { on: jest.fn() },
          stdin: { on: jest.fn(), write: jest.fn(), end: jest.fn() },
          on: (ev: string, fn: Function) => {
            (handlers[ev] ||= []).push(fn);
          },
        };
        // Schedule async stdout + close on the next tick so the service's
        // event-handler registrations take effect first.
        setImmediate(() => {
          const judgeJson = JSON.stringify({
            pass_fail_status: 'passed',
            reasoning: 'cp-oncall verdict',
            custom_score: 88,
            // intentional extra key to prove extraFields capture works
            // through the spawned-CLI path:
            failure_tags: ['none'],
          });
          const wrapped = JSON.stringify({ result: judgeJson });
          handlers['stdout.data']?.forEach((fn) => fn(Buffer.from(wrapped)));
          handlers['close']?.forEach((fn) => fn(0));
        });
        return child;
      }),
    }));
  });

  it('forwards evaluator.systemPrompt to claude --append-system-prompt and honors scoringConfig.metrics', async () => {
    const { evaluateWithClaudeCode } = await import('@/server/services/claudeCodeJudgeService');
    const evaluator = makeCustomEvaluator();
    const out = await evaluateWithClaudeCode(
      {
        trajectory: [{ type: 'action', toolName: 'search' } as any],
        expectedOutcomes: ['Identify root cause'],
      },
      evaluator
    );

    // Contract 1: saved system prompt actually reaches the spawned CLI.
    expect(capturedSystemPrompt).toContain('You are the CP-Oncall judge');
    // Contract 2: the evaluator's custom metric flowed through; the legacy
    // hardcoded 4-metric schema is no longer hardcoded into the service.
    expect(out.metrics.custom_score).toBe(88);
    expect(out.passFailStatus).toBe('passed');
    // Contract 3: extraFields the model emitted are surfaced (was dropped pre-fix).
    expect(out.extraFields).toEqual({ failure_tags: ['none'] });
    // Contract 4: rawResponse is captured for the run-detail debug surface.
    expect(out.rawResponse).toContain('cp-oncall verdict');
  });

  it('falls back to JUDGE_SYSTEM_PROMPT baseline when no evaluator is passed (back-compat)', async () => {
    const { evaluateWithClaudeCode } = await import('@/server/services/claudeCodeJudgeService');
    await evaluateWithClaudeCode({
      trajectory: [{ type: 'action' } as any],
      expectedOutcomes: ['x'],
    });

    // Without an evaluator the baseline JUDGE_SYSTEM_PROMPT is in effect.
    // We don't pin its full content (it lives in server/prompts/judgePrompt
    // and may evolve), only that it's NOT the cp-oncall string.
    expect(capturedSystemPrompt).not.toContain('CP-Oncall judge');
    expect(capturedSystemPrompt && capturedSystemPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pi provider (CLI subprocess)
// ---------------------------------------------------------------------------

describe('piJudgeService — evaluator wiring', () => {
  let capturedSystemPrompt: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    capturedSystemPrompt = undefined;

    // Stub the resolver so we don't hit the real pi binary lookup.
    jest.doMock('@/server/services/piBinary', () => ({
      resolvePiCommand: () => ({ command: 'pi', prefixArgs: [], bundled: false }),
    }));

    jest.doMock('child_process', () => ({
      spawn: jest.fn((_cmd: string, args: string[]) => {
        const idx = args.indexOf('--system-prompt');
        capturedSystemPrompt = idx >= 0 ? args[idx + 1] : undefined;
        const handlers: Record<string, Function[]> = {};
        const child: any = {
          stdout: {
            on: (ev: string, fn: Function) => {
              (handlers[`stdout.${ev}`] ||= []).push(fn);
            },
          },
          stderr: { on: jest.fn() },
          stdin: { on: jest.fn(), write: jest.fn(), end: jest.fn() },
          on: (ev: string, fn: Function) => {
            (handlers[ev] ||= []).push(fn);
          },
        };
        setImmediate(() => {
          const judgeJson = JSON.stringify({
            pass_fail_status: 'passed',
            reasoning: 'pi verdict',
            custom_score: 75,
          });
          const wrapped = JSON.stringify({ result: judgeJson });
          handlers['stdout.data']?.forEach((fn) => fn(Buffer.from(wrapped)));
          handlers['close']?.forEach((fn) => fn(0));
        });
        return child;
      }),
    }));
  });

  it('forwards evaluator.systemPrompt to pi --system-prompt and honors scoringConfig.metrics', async () => {
    const { evaluateWithPi } = await import('@/server/services/piJudgeService');
    const out = await evaluateWithPi(
      {
        trajectory: [{ type: 'action', toolName: 'search' } as any],
        expectedOutcomes: ['Identify root cause'],
      },
      makeCustomEvaluator()
    );

    expect(capturedSystemPrompt).toContain('You are the CP-Oncall judge');
    expect(out.metrics.custom_score).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// agentic provider (claude-code agentic backend)
// ---------------------------------------------------------------------------

describe('agenticJudgeService — evaluator wiring', () => {
  let capturedSystemPrompt: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    capturedSystemPrompt = undefined;
    jest.doMock('child_process', () => ({
      spawn: jest.fn((_cmd: string, args: string[]) => {
        const idx = args.indexOf('--append-system-prompt');
        capturedSystemPrompt = idx >= 0 ? args[idx + 1] : undefined;
        const handlers: Record<string, Function[]> = {};
        const child: any = {
          stdout: {
            on: (ev: string, fn: Function) => {
              (handlers[`stdout.${ev}`] ||= []).push(fn);
            },
          },
          stderr: { on: jest.fn() },
          stdin: { on: jest.fn(), write: jest.fn(), end: jest.fn() },
          on: (ev: string, fn: Function) => {
            (handlers[ev] ||= []).push(fn);
          },
        };
        setImmediate(() => {
          const judgeJson = JSON.stringify({
            pass_fail_status: 'passed',
            reasoning: 'agentic verdict',
            custom_score: 91,
          });
          const wrapped = JSON.stringify({ result: judgeJson });
          handlers['stdout.data']?.forEach((fn) => fn(Buffer.from(wrapped)));
          handlers['close']?.forEach((fn) => fn(0));
        });
        return child;
      }),
    }));
  });

  it('forwards evaluator.systemPrompt + AGENTIC_JUDGE_ADDENDUM and honors scoringConfig.metrics', async () => {
    const { evaluateWithAgenticJudge } = await import('@/server/services/agenticJudgeService');
    const out = await evaluateWithAgenticJudge(
      {
        trajectory: [{ type: 'action', toolName: 'search' } as any],
        expectedOutcomes: ['Identify root cause'],
      },
      { backend: 'claude-code' },
      makeCustomEvaluator()
    );

    // The saved prompt is in effect...
    expect(capturedSystemPrompt).toContain('You are the CP-Oncall judge');
    // ...AND the agentic-judge addendum is still appended (its trigger
    // phrase is the marker — see AGENTIC_JUDGE_ADDENDUM in the service).
    expect(capturedSystemPrompt).toContain('Agentic Evaluation Mode');
    expect(out.metrics.custom_score).toBe(91);
  });
});
