/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge debug toggle.
 *
 * When `AH_JUDGE_DEBUG=1` (or `AGENT_HEALTH_JUDGE_DEBUG=1`, the deprecated
 * spelling per #231) every judge service captures the system prompt and user
 * prompt it actually sent to the model and stuffs them into
 * {@link JudgeResponse.judgeDebug}. The routing layer then propagates that
 * onto the persisted {@link LLMJudgeResponse.judgeDebug} so the run-detail
 * UI's "Judge debug" tab can show:
 *
 *   1. Was my saved evaluator's `systemPrompt` what the model actually saw?
 *   2. What was the user prompt?
 *   3. What raw text did the model emit before we coerced it?
 *
 * Debug mode is opt-in (env-gated) because system prompts can be 10\u201320 KB \u2014
 * shipping them on every run by default would bloat persisted run docs and
 * the wire payload to the UI for every judge call. Only an explicit local
 * `NODE_ENV === 'development'` auto-enables it (CI/staging with NODE_ENV unset
 * stay OFF, to avoid persisting sensitive prompts) — everything else must set
 * `AH_JUDGE_DEBUG=1`.
 */

import { readEnv } from '@/lib/envCompat';

/** Returns true when judge calls should capture and propagate prompt text. */
export function isJudgeDebugEnabled(): boolean {
  const flag = readEnv('AH_JUDGE_DEBUG', 'AGENT_HEALTH_JUDGE_DEBUG');
  if (flag === '0' || flag === 'false') return false;
  if (flag === '1' || flag === 'true') return true;
  // Default ON only in an explicit local `development` environment for fast
  // iteration. Crucially this is `=== 'development'`, NOT `!== 'production'`:
  // CI and many staging setups leave NODE_ENV unset, and capturing full
  // system/user prompts (up to ~20 KB, persisted + rendered) there could
  // expose sensitive evaluator instructions. Those environments must opt in
  // explicitly via AH_JUDGE_DEBUG=1.
  return process.env.NODE_ENV === 'development';
}

export interface JudgeDebugContext {
  provider: string;
  modelId?: string;
  evaluatorId?: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Build the `judgeDebug` payload to attach to a JudgeResponse, or return
 * `undefined` when debug capture is disabled. Centralizing the gate here
 * keeps the call site in each service a one-liner and ensures the env-flag
 * semantics stay consistent.
 */
export function buildJudgeDebug(ctx: JudgeDebugContext): JudgeDebugContext | undefined {
  if (!isJudgeDebugEnabled()) return undefined;
  return ctx;
}
