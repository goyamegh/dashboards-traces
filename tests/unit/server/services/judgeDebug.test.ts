/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isJudgeDebugEnabled, buildJudgeDebug } from '@/server/services/judgeDebug';

describe('judgeDebug', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Each test gets a clean slate \u2014 we mutate AH_JUDGE_DEBUG /
    // AGENT_HEALTH_JUDGE_DEBUG / NODE_ENV directly.
    process.env = { ...originalEnv };
    delete process.env.AH_JUDGE_DEBUG;
    delete process.env.AGENT_HEALTH_JUDGE_DEBUG;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isJudgeDebugEnabled', () => {
    it('is enabled when AH_JUDGE_DEBUG=1', () => {
      process.env.AH_JUDGE_DEBUG = '1';
      expect(isJudgeDebugEnabled()).toBe(true);
    });

    it('is enabled when AH_JUDGE_DEBUG=true', () => {
      process.env.AH_JUDGE_DEBUG = 'true';
      expect(isJudgeDebugEnabled()).toBe(true);
    });

    it('is disabled when AH_JUDGE_DEBUG=0 (explicit opt-out beats env default)', () => {
      process.env.AH_JUDGE_DEBUG = '0';
      process.env.NODE_ENV = 'development';
      expect(isJudgeDebugEnabled()).toBe(false);
    });

    it('honors the deprecated AGENT_HEALTH_JUDGE_DEBUG spelling (#231)', () => {
      // Per #231 the AGENT_HEALTH_* env vars were softly renamed to AH_*.
      // readEnv falls back to the old name so existing callers don't break.
      process.env.AGENT_HEALTH_JUDGE_DEBUG = '1';
      process.env.NODE_ENV = 'production'; // would otherwise default-off
      expect(isJudgeDebugEnabled()).toBe(true);
    });

    it('defaults ON in dev so local iteration loops do not have to flip it', () => {
      process.env.NODE_ENV = 'development';
      expect(isJudgeDebugEnabled()).toBe(true);
    });

    it('defaults OFF in production to keep persisted run docs lean', () => {
      // System prompts can be 10\u201320 KB \u2014 shipping them on every prod run
      // would bloat the run index for no benefit. Operators have to opt in.
      process.env.NODE_ENV = 'production';
      expect(isJudgeDebugEnabled()).toBe(false);
    });

    it('defaults OFF when NODE_ENV is unset (CI / staging) - only explicit development auto-enables', () => {
      // Security (PR #265 review): CI and many staging setups leave NODE_ENV
      // unset. Capturing full system/user prompts there could expose
      // sensitive evaluator instructions, so the auto-on is gated on
      // === 'development', not !== 'production'. Unset => OFF unless
      // AH_JUDGE_DEBUG=1 is set explicitly.
      delete process.env.NODE_ENV;
      expect(isJudgeDebugEnabled()).toBe(false);
      process.env.NODE_ENV = 'staging';
      expect(isJudgeDebugEnabled()).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(isJudgeDebugEnabled()).toBe(false);
    });
  });

  describe('buildJudgeDebug', () => {
    it('returns the context verbatim when debug is enabled', () => {
      process.env.AH_JUDGE_DEBUG = '1';
      const ctx = {
        provider: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4',
        evaluatorId: 'eval-cp-oncall',
        systemPrompt: 'sys',
        userPrompt: 'usr',
      };
      expect(buildJudgeDebug(ctx)).toEqual(ctx);
    });

    it('returns undefined when debug is disabled (so spread-into-response is a no-op)', () => {
      process.env.AH_JUDGE_DEBUG = '0';
      process.env.NODE_ENV = 'production';
      expect(
        buildJudgeDebug({ provider: 'pi', systemPrompt: 'sys', userPrompt: 'usr' })
      ).toBeUndefined();
    });
  });
});
