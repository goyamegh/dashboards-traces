/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveContextWindow,
  contextUtilizationPct,
  formatContextPct,
} from '@/lib/contextUtilization';

describe('contextUtilization', () => {
  describe('resolveContextWindow', () => {
    it('resolves by registry key', () => {
      // claude-opus-4.6 is a registry key with a 200k window
      expect(resolveContextWindow('claude-opus-4.6')).toBe(200000);
    });

    it('resolves by provider model_id', () => {
      // gen_ai.request.model reports the provider model_id
      expect(resolveContextWindow('us.anthropic.claude-opus-4-6-v1')).toBe(200000);
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(resolveContextWindow('  CLAUDE-OPUS-4.6  ')).toBe(200000);
    });

    it('resolves a non-Claude model with a different window', () => {
      expect(resolveContextWindow('gpt-4o')).toBe(128000);
    });

    it('returns undefined for unknown / empty models', () => {
      expect(resolveContextWindow('totally-made-up-model')).toBeUndefined();
      expect(resolveContextWindow('')).toBeUndefined();
      expect(resolveContextWindow(undefined)).toBeUndefined();
      expect(resolveContextWindow(null)).toBeUndefined();
    });
  });

  describe('contextUtilizationPct', () => {
    it('computes peak input tokens over the resolved window', () => {
      // 50k of a 200k window = 25%
      expect(contextUtilizationPct(50000, 'claude-opus-4.6')).toBeCloseTo(25, 5);
    });

    it('can exceed 100 (over-budget signal, not clamped)', () => {
      expect(contextUtilizationPct(240000, 'claude-opus-4.6')).toBeCloseTo(120, 5);
    });

    it('returns undefined for unknown model', () => {
      expect(contextUtilizationPct(50000, 'mystery-model')).toBeUndefined();
    });

    it('returns undefined for missing / non-positive token counts', () => {
      expect(contextUtilizationPct(0, 'claude-opus-4.6')).toBeUndefined();
      expect(contextUtilizationPct(undefined, 'claude-opus-4.6')).toBeUndefined();
      expect(contextUtilizationPct(-10, 'claude-opus-4.6')).toBeUndefined();
    });
  });

  describe('formatContextPct', () => {
    it('uses one decimal under 10%', () => {
      expect(formatContextPct(2.5)).toBe('2.5%');
    });

    it('rounds to whole numbers at/above 10%', () => {
      expect(formatContextPct(24.7)).toBe('25%');
      expect(formatContextPct(120)).toBe('120%');
    });

    it('passes through undefined / non-finite', () => {
      expect(formatContextPct(undefined)).toBeUndefined();
      expect(formatContextPct(Infinity)).toBeUndefined();
      expect(formatContextPct(NaN)).toBeUndefined();
    });
  });
});
