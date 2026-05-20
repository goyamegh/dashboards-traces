/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';

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

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  evaluate: (result: EvalResult) => Promise<void> | void;
  /** Resolved file the test was registered from — set by the loader. */
  sourceFile?: string;
}

export interface EvalResult {
  trajectory: TrajectoryStep[];
  agentOutput: string;
  rawEvents: any[];
  runId?: string;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
}
