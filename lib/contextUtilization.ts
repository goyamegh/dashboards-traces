/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context-window utilization
 *
 * "Ctx%" = how close a single LLM request came to filling the model's
 * context window. It is computed from the *peak* single-request input-token
 * count (NOT the sum across the whole trace — each turn re-sends the running
 * context, so summing would massively overcount and routinely exceed 100%)
 * divided by the model's configured `context_window`.
 *
 * The model registry in {@link DEFAULT_CONFIG} carries `context_window` per
 * model, keyed by both a short key (e.g. `claude-opus-4.6`) and a provider
 * `model_id` (e.g. `us.anthropic.claude-opus-4-6-v1`). Traces report the
 * `model_id` via `gen_ai.request.model`, while the rest of the app uses the
 * short key — so we resolve against both.
 */

import { DEFAULT_CONFIG } from '@/lib/constants';

/**
 * Resolve a model's context-window size (in tokens) from the registry.
 *
 * Matches a model reference against either the registry key or the provider
 * `model_id`, case-insensitively. Returns `undefined` for unknown models so
 * callers can omit Ctx% rather than display a misleading 0 / 100%.
 */
export function resolveContextWindow(model: string | undefined | null): number | undefined {
  if (!model) return undefined;
  const needle = model.trim().toLowerCase();
  if (!needle) return undefined;

  const models = (DEFAULT_CONFIG as { models?: Record<string, { model_id?: string; context_window?: number }> }).models;
  if (!models) return undefined;

  for (const [key, def] of Object.entries(models)) {
    if (!def || typeof def.context_window !== 'number' || def.context_window <= 0) continue;
    if (key.toLowerCase() === needle) return def.context_window;
    if (typeof def.model_id === 'string' && def.model_id.toLowerCase() === needle) return def.context_window;
  }
  return undefined;
}

/**
 * Context-window utilization as a percentage (0–100+), or `undefined` when it
 * cannot be computed (unknown model, non-positive window, missing tokens).
 *
 * Not clamped to 100: a value above 100 is a meaningful signal that the peak
 * request exceeded the configured window (stale registry, or a larger-context
 * model variant), and the caller can surface it as an over-budget warning.
 */
export function contextUtilizationPct(
  peakInputTokens: number | undefined | null,
  model: string | undefined | null,
): number | undefined {
  if (typeof peakInputTokens !== 'number' || !(peakInputTokens > 0)) return undefined;
  const window = resolveContextWindow(model);
  if (!window) return undefined;
  return (peakInputTokens / window) * 100;
}

/**
 * Format a Ctx% value for display: one decimal place under 10%, none above,
 * with a trailing `%`. Returns `undefined` passthrough for unknown values.
 */
export function formatContextPct(pct: number | undefined): string | undefined {
  if (typeof pct !== 'number' || !isFinite(pct)) return undefined;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}
