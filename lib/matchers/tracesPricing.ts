/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fallback pricing table used by `buildTracesAccessor()` (see
 * `lib/matchers/traces.ts`) to *compute* `totalCost` when spans carry
 * token-usage attributes but no cost attribute (this is the common case —
 * most OTel exporters, including Claude Code's, emit raw token counts and
 * leave cost calculation to the consumer).
 *
 * Rates are USD per **million tokens** (MTok), converted to per-token below.
 * These are point-in-time *estimates* maintained by hand — update them when
 * pricing changes. They are intentionally separate from
 * `server/services/codingAgents/pricing.ts` (used by the coding-agent
 * analytics/leaderboard feature): that table silently falls back to Sonnet
 * pricing for unknown models, which is the wrong behavior here — an eval
 * reading `traces.totalCost` for an unpriced model must know the number is
 * incomplete (see `buildTracesAccessor`'s fail-loud handling), not get a
 * silently-substituted estimate.
 */

export interface ModelRates {
  /** USD per input (prompt) token. */
  input: number;
  /** USD per output (completion) token. */
  output: number;
  /** USD per cache-read token (cheaper than a fresh input token). */
  cacheRead: number;
  /** USD per cache-creation/write token (pricier than a fresh input token). */
  cacheCreation: number;
}

const PER_MTOK = 1_000_000;

/**
 * Estimated Bedrock/Anthropic Claude rates, USD per MTok:
 *   Sonnet class: $3 in / $15 out / $0.30 cache-read / $3.75 cache-write
 *   Opus class:   $15 in / $75 out / $1.50 cache-read / $18.75 cache-write
 *   Haiku class:  $0.80 in / $4 out / $0.08 cache-read / $1.00 cache-write
 * Keyed by substrings matched case-insensitively against the span's model
 * id (see `resolveModelId`), so both raw Anthropic ids
 * (`claude-sonnet-4-6-...`) and Bedrock ids
 * (`us.anthropic.claude-sonnet-4-6-...`) match.
 */
const RATE_TABLE: Array<{ match: RegExp; rates: ModelRates }> = [
  {
    match: /opus/i,
    rates: {
      input: 15 / PER_MTOK,
      output: 75 / PER_MTOK,
      cacheRead: 1.5 / PER_MTOK,
      cacheCreation: 18.75 / PER_MTOK,
    },
  },
  {
    match: /haiku/i,
    rates: {
      input: 0.8 / PER_MTOK,
      output: 4 / PER_MTOK,
      cacheRead: 0.08 / PER_MTOK,
      cacheCreation: 1.0 / PER_MTOK,
    },
  },
  {
    // Sonnet is the default Claude class; matched last so opus/haiku take
    // priority, but also serves as the generic "claude" match.
    match: /sonnet|claude/i,
    rates: {
      input: 3 / PER_MTOK,
      output: 15 / PER_MTOK,
      cacheRead: 0.3 / PER_MTOK,
      cacheCreation: 3.75 / PER_MTOK,
    },
  },
];

/** Look up rates for a model id. Returns `undefined` when no rule matches. */
export function lookupModelRates(modelId: string | undefined): ModelRates | undefined {
  if (!modelId) return undefined;
  for (const { match, rates } of RATE_TABLE) {
    if (match.test(modelId)) return rates;
  }
  return undefined;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Compute USD cost for a set of token counts against a model's rates. */
export function computeCost(tokens: UsageTokens, rates: ModelRates): number {
  return (
    tokens.input * rates.input +
    tokens.output * rates.output +
    tokens.cacheRead * rates.cacheRead +
    tokens.cacheCreation * rates.cacheCreation
  );
}
