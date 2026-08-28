/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { lookupModelRates, computeCost } from '@/lib/matchers/tracesPricing';

describe('lookupModelRates', () => {
  it('returns undefined for an undefined model id', () => {
    expect(lookupModelRates(undefined)).toBeUndefined();
  });

  it('returns undefined for an unrecognized model id', () => {
    expect(lookupModelRates('some-totally-unknown-model-9000')).toBeUndefined();
  });

  it('matches sonnet-class models (raw Anthropic id)', () => {
    const rates = lookupModelRates('claude-sonnet-4-6-20260101');
    expect(rates).toEqual({
      input: 3 / 1_000_000,
      output: 15 / 1_000_000,
      cacheRead: 0.3 / 1_000_000,
      cacheCreation: 3.75 / 1_000_000,
    });
  });

  it('matches sonnet-class models via Bedrock-style id', () => {
    const rates = lookupModelRates('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(rates?.input).toBeCloseTo(3 / 1_000_000, 10);
  });

  it('matches opus-class models with higher rates than sonnet', () => {
    const rates = lookupModelRates('claude-opus-4-6');
    expect(rates).toEqual({
      input: 15 / 1_000_000,
      output: 75 / 1_000_000,
      cacheRead: 1.5 / 1_000_000,
      cacheCreation: 18.75 / 1_000_000,
    });
  });

  it('matches haiku-class models with lower rates than sonnet', () => {
    const rates = lookupModelRates('claude-haiku-4-5');
    expect(rates).toEqual({
      input: 0.8 / 1_000_000,
      output: 4 / 1_000_000,
      cacheRead: 0.08 / 1_000_000,
      cacheCreation: 1.0 / 1_000_000,
    });
  });

  it('falls back to sonnet-class rates for a generic "claude" id with no tier keyword', () => {
    const rates = lookupModelRates('claude-3-5-something');
    expect(rates?.input).toBeCloseTo(3 / 1_000_000, 10);
  });
});

describe('computeCost', () => {
  const sonnet = lookupModelRates('claude-sonnet-4-6')!;

  it('computes cost across input/output/cache-read/cache-creation tokens', () => {
    const cost = computeCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
      sonnet,
    );
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
  });

  it('returns 0 for zero tokens', () => {
    expect(computeCost({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, sonnet)).toBe(0);
  });
});
