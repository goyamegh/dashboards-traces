/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseJudgeResponse,
  extractJsonFromResponse,
} from '@/server/services/judgeResponseParser';
import type { Evaluator } from '@/types';

/** Minimal Evaluator stub matching the fields the parser actually consults. */
function makeEvaluator(metricNames: string[]): Evaluator {
  return {
    id: 'eval-test',
    name: 'Test',
    description: '',
    isSystem: false,
    systemPrompt: '',
    scoringConfig: {
      metrics: metricNames.map((name) => ({ name, description: '', weight: 1, scale: 100 })),
      passThreshold: 70,
      scale: 100,
    },
    inferenceConfig: {},
  } as unknown as Evaluator;
}

describe('judgeResponseParser', () => {
  describe('extractJsonFromResponse', () => {
    it('pulls JSON out of a markdown ```json fence', () => {
      const input = 'prose\n```json\n{"a":1}\n```\ntrailer';
      expect(extractJsonFromResponse(input)).toBe('{"a":1}');
    });

    it('pulls bare {...} JSON out of surrounding prose', () => {
      // Some models still emit prose despite being told not to. The parser
      // must not blow up on that.
      const input = 'Here you go: {"a":1, "b":2} (cheers)';
      expect(extractJsonFromResponse(input)).toBe('{"a":1, "b":2}');
    });

    it('returns undefined when there is no JSON object at all', () => {
      expect(extractJsonFromResponse('no json here')).toBeUndefined();
    });
  });

  describe('parseJudgeResponse', () => {
    it('captures rawResponse exactly as provided', () => {
      const raw = '{"pass_fail_status":"passed","reasoning":"ok","accuracy":90}';
      const out = parseJudgeResponse(raw);
      expect(out.rawResponse).toBe(raw);
    });

    it('coerces pass_fail_status, reasoning, improvement_strategies', () => {
      const raw = JSON.stringify({
        pass_fail_status: 'passed',
        reasoning: 'looks good',
        improvement_strategies: [
          { category: 'tools', issue: 'x', recommendation: 'y', priority: 'low' },
        ],
        accuracy: 85,
      });
      const out = parseJudgeResponse(raw);
      expect(out.passFailStatus).toBe('passed');
      expect(out.llmJudgeReasoning).toBe('looks good');
      expect(out.improvementStrategies).toHaveLength(1);
    });

    it('treats anything other than literal "passed" as failed', () => {
      // Defensive: model occasionally emits "FAIL" / "fail" / "false". The
      // typed wire shape is binary, so anything not exactly "passed" must
      // become "failed" \u2014 which is the safe default.
      for (const status of ['failed', 'FAIL', 'fail', '', null, undefined]) {
        const raw = JSON.stringify({ pass_fail_status: status, reasoning: 'r', accuracy: 0 });
        expect(parseJudgeResponse(raw).passFailStatus).toBe('failed');
      }
    });

    describe('with evaluator (dynamic metrics)', () => {
      it('extracts metrics declared by the evaluator from top-level keys', () => {
        const evaluator = makeEvaluator(['custom_score', 'tool_correctness']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          tool_correctness: 95,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics).toEqual({ custom_score: 80, tool_correctness: 95 });
      });

      it('extracts metrics from nested `metrics` object (legacy shape)', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          metrics: { custom_score: 72 },
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.custom_score).toBe(72);
      });

      it('extracts metrics from a rubric-style `scores` object', () => {
        // The AES Oncall evaluator (and other rubric-style judges) emit
        // dimension scores under a `scores` key. Without this fallback the
        // declared metrics would be silently missing even though the values
        // are clearly in the JSON.
        const evaluator = makeEvaluator(['tool_correctness', 'diagnostic_completeness']);
        const raw = JSON.stringify({
          pass_fail_status: 'failed',
          reasoning: 'r',
          scores: { tool_correctness: 30, diagnostic_completeness: 40, calibration: 60 },
          weighted_score: 35,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.tool_correctness).toBe(30);
        expect(out.metrics.diagnostic_completeness).toBe(40);
        // `calibration` wasn't declared so it lands in extraFields.scores_unmapped,
        // not in `metrics`.
        expect(out.metrics).not.toHaveProperty('calibration');
        expect(out.extraFields?.scores_unmapped).toEqual({ calibration: 60 });
        // `weighted_score` is a typical extra field on rubric prompts.
        expect(out.extraFields?.weighted_score).toBe(35);
      });

      it('drops missing metrics silently (does not synthesize a 0)', () => {
        // If the model didn't emit a metric, downstream UIs need to be able
        // to tell the difference between "scored 0" and "didn't score". We
        // chose not-emitted = absent.
        const evaluator = makeEvaluator(['custom_score', 'never_present']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 50,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics).toEqual({ custom_score: 50 });
      });

      it('coerces stringified numbers ("85") to numbers', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: '85',
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.custom_score).toBe(85);
      });
    });

    describe('without evaluator (legacy fallback)', () => {
      it('extracts the legacy 4-metric set so old standalone callers keep working', () => {
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          accuracy: 88,
          metrics: { faithfulness: 90, latency_score: 70, trajectory_alignment_score: 80 },
        });
        const out = parseJudgeResponse(raw);
        expect(out.metrics.accuracy).toBe(88);
        expect(out.metrics.faithfulness).toBe(90);
        expect(out.metrics.latency_score).toBe(70);
        expect(out.metrics.trajectory_alignment_score).toBe(80);
      });

      it('defaults accuracy to 0 when absent (legacy shape contract)', () => {
        // Pre-fix code had `accuracy ?? 0` baked into every spawned-CLI
        // service; preserve that fallback in the legacy-no-evaluator path
        // so back-compat callers (the unit test that exercises
        // parsePiJudgeJson standalone) keep getting accuracy=0.
        const raw = JSON.stringify({ pass_fail_status: 'passed', reasoning: 'r' });
        const out = parseJudgeResponse(raw);
        expect(out.metrics.accuracy).toBe(0);
      });
    });

    describe('extraFields capture (the prompt-iteration escape hatch)', () => {
      it('captures top-level keys the model emitted that are not typed', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          // these are NEW prompt outputs the user added
          improvement_candidates: ['call search_logs sooner'],
          failure_tags: ['budget-overshoot'],
          confidence: 0.72,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.extraFields).toEqual({
          improvement_candidates: ['call search_logs sooner'],
          failure_tags: ['budget-overshoot'],
          confidence: 0.72,
        });
      });

      it('captures metrics keys the evaluator did not declare into metrics_unmapped', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          metrics: {
            custom_score: 80,             // declared \u2014 consumed
            confidence: 90,               // not declared and not legacy \u2014 captured
          },
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.extraFields?.metrics_unmapped).toEqual({ confidence: 90 });
      });

      it('returns extraFields=undefined when the model emitted ONLY typed fields', () => {
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          accuracy: 90,
          improvement_strategies: [],
        });
        const out = parseJudgeResponse(raw);
        expect(out.extraFields).toBeUndefined();
      });
    });

    it('throws a labelled error when the response has no JSON object', () => {
      expect(() => parseJudgeResponse('not json', { source: 'TestSrc' })).toThrow(/TestSrc/);
    });

    it('throws a labelled error when the JSON is malformed', () => {
      expect(() => parseJudgeResponse('{bad json', { source: 'TestSrc' })).toThrow(/TestSrc/);
    });
  });
});
