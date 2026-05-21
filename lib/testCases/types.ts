/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import type { TracesAccessor } from '../matchers/index.js';

/**
 * Options for a code-based test case.
 *
 * All fields are optional. Only the test name (the first argument to
 * `test()`) is required. When `prompt` is omitted, the runner skips agent
 * invocation entirely and the test body runs against an empty EvalResult —
 * useful for purely deterministic / data-driven tests.
 *
 * Categories and difficulty levels live in `labels` as prefixed strings
 * (e.g. `'category:RCA'`, `'difficulty:Medium'`). The legacy top-level
 * `category` / `difficulty` keys were removed in favor of this single
 * unified tagging system.
 */
export interface TestOptions {
  /**
   * Initial prompt sent to the agent. When omitted, the runner does not
   * invoke the agent and the test body receives an empty EvalResult.
   */
  prompt?: string;
  /** Free-form description shown in the UI. */
  description?: string;
  /** Additional context items passed to the agent alongside the prompt. */
  context?: { description: string; value: string }[];
  /**
   * Labels for filtering and grouping. Use prefixed strings for what was
   * previously `category` and `difficulty`:
   * `['category:RCA', 'difficulty:Medium', 'team:platform']`.
   */
  labels?: string[];
  /** Per-test timeout override in milliseconds. */
  timeout?: number;
}

/**
 * The trajectory accessor namespace exposed via EvalResult.trajectory in
 * the new SDK. It IS the same array returned by the runner so users can
 * iterate freely; the helpers are added as non-enumerable methods so
 * `for/of` and JSON.stringify behave naturally.
 */
export interface TrajectoryAccessor extends Array<TrajectoryStep> {
  /** Steps of the given type, in order of occurrence. */
  stepsOfType(type: string): TrajectoryStep[];
  /** All `action` steps, optionally filtered by toolName and partial args. */
  toolCalls(name?: string, argsPartial?: Record<string, unknown>): TrajectoryStep[];
  /** First action-step matching, with `.index` annotated for ordering checks, or null. */
  firstToolCall(
    name?: string,
    argsPartial?: Record<string, unknown>
  ): (TrajectoryStep & { index: number }) | null;
}

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  evaluate: TestBodyFn | LegacyEvaluateFn;
  /** Resolved file the test was registered from — set by the loader. */
  sourceFile?: string;
  /**
   * Benchmark group path — the joined `describe('...', ...)` names that
   * wrapped this `test()` call, joined with ' > ' for nested describes.
   * `undefined` when the test was registered outside any describe; the
   * loader/CLI then puts the test into the file-default benchmark.
   */
  benchmarkPath?: string;
}

/**
 * The Playwright-style test body signature: receives a fixtures object
 * with `result`, `judge`, `traces`, and `expect`.
 */
export type TestBodyFn = (fixtures: TestFixtures) => Promise<void> | void;

/**
 * Legacy single-arg signature kept for backward compatibility. Old code
 * that did `test(name, opts, async (result) => { ... })` keeps working.
 */
export type LegacyEvaluateFn = (result: EvalResult) => Promise<void> | void;

export interface TestFixtures {
  result: EvalResult;
  judge: typeof import('./judge.js').judge;
  traces: TracesAccessor;
  expect: typeof import('../matchers/expect.js').expect;
}

export interface EvalResult {
  /** All trajectory steps with sugar accessors (toolCalls, firstToolCall, etc.). */
  trajectory: TrajectoryAccessor;
  /** Concatenated final response text from the agent's `assistant`/`response` steps. */
  agentOutput: string;
  /** Convenience: same as agentOutput. Returns the last assistant text. */
  finalResponse(): string;
  /** Try-parse `agentOutput` as JSON. Returns undefined when not parseable. */
  parsedOutput(): unknown;
  /** Raw AG-UI events as received from the agent. */
  rawEvents: any[];
  /** Agent-supplied run id (for log/trace correlation). */
  runId?: string;
  /** Wall-clock duration of the agent invocation in ms (0 when no prompt). */
  durationMs: number;
  /** Token usage when reported by the agent. */
  tokenUsage?: { prompt: number; completion: number; total: number };
}
