/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';

export interface TestOptions {
  prompt: string;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  description?: string;
  context?: { description: string; value: string }[];
  labels?: string[];
  timeout?: number;
}

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  evaluate: (result: EvalResult) => Promise<void> | void;
}

export interface EvalResult {
  trajectory: TrajectoryStep[];
  agentOutput: string;
  rawEvents: any[];
  runId?: string;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
}
