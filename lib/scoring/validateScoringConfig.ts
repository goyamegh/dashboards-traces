/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structural validation of an evaluator's `scoringConfig`, shared by the
 * evaluator CRUD routes (reject on POST/PUT) and the editor (inline hint).
 * Pure; returns the first problem as a human-readable string, `null` when
 * the config is acceptable.
 */

import type { ScoringConfig } from '@/types';

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether an evaluator scores without an LLM judge. Detected structurally
 * (any of: `evaluator.kind === 'deterministic'`, `inferenceConfig.provider
 * === 'deterministic'`, or a metric tagged `kind`/`source: 'deterministic'`)
 * so this stays decoupled from the deterministic-scoring module's exact
 * shape; reconcile when that lands.
 */
export function isDeterministicEvaluator(evaluator: unknown): boolean {
  if (!evaluator || typeof evaluator !== 'object') return false;
  const e = evaluator as Record<string, any>;
  if (e.kind === 'deterministic') return true;
  if (e.inferenceConfig?.provider === 'deterministic') return true;
  const metrics = e.scoringConfig?.metrics;
  return Array.isArray(metrics) && metrics.some((m: any) => m?.kind === 'deterministic' || m?.source === 'deterministic');
}

export interface ValidateScoringOptions {
  /** A deterministic evaluator has no LLM verdict to defer to, so `llm-verdict` is rejected. */
  deterministic?: boolean;
}

export function validateScoringConfig(config: unknown, options: ValidateScoringOptions = {}): string | null {
  if (!config || typeof config !== 'object') return 'scoringConfig must be an object';
  const c = config as Partial<ScoringConfig> & Record<string, unknown>;

  if (!Array.isArray(c.metrics) || c.metrics.length === 0) {
    return 'scoringConfig.metrics must be a non-empty array';
  }
  const names = new Set<string>();
  for (const [i, m] of c.metrics.entries()) {
    if (!m || typeof m !== 'object') return `scoringConfig.metrics[${i}] must be an object`;
    if (typeof m.name !== 'string' || !m.name.trim()) return `scoringConfig.metrics[${i}].name is required`;
    if (names.has(m.name)) return `scoringConfig.metrics: duplicate metric name '${m.name}'`;
    names.add(m.name);
    if (!isFiniteNumber(m.weight) || m.weight <= 0) {
      return `scoringConfig.metrics '${m.name}': weight must be a number > 0`;
    }
    if (m.scale !== undefined && (!isFiniteNumber(m.scale) || m.scale <= 0)) {
      return `scoringConfig.metrics '${m.name}': scale must be a number > 0`;
    }
  }

  if (c.primaryMetrics !== undefined) {
    if (!Array.isArray(c.primaryMetrics) || c.primaryMetrics.some(p => typeof p !== 'string')) {
      return 'scoringConfig.primaryMetrics must be an array of metric names';
    }
    for (const p of c.primaryMetrics) {
      if (!names.has(p)) return `scoringConfig.primaryMetrics references unknown metric '${p}'`;
    }
  }

  const policy = c.passPolicy as Record<string, unknown> | undefined;
  if (options.deterministic && (policy === undefined || policy?.kind === 'llm-verdict')) {
    return "scoringConfig.passPolicy: a deterministic evaluator has no LLM verdict — use 'threshold' or 'gates'";
  }
  if (policy !== undefined) {
    if (!policy || typeof policy !== 'object') return 'scoringConfig.passPolicy must be an object';
    switch (policy.kind) {
      case 'llm-verdict':
        break;
      case 'threshold':
        if (!isFiniteNumber(policy.minScore) || policy.minScore < 0 || policy.minScore > 1) {
          return 'scoringConfig.passPolicy.minScore must be a number in [0, 1] (normalized score)';
        }
        break;
      case 'gates': {
        if (!Array.isArray(policy.gates) || policy.gates.length === 0) {
          return 'scoringConfig.passPolicy.gates must be a non-empty array';
        }
        for (const g of policy.gates as Array<Record<string, unknown>>) {
          if (!g || typeof g !== 'object' || typeof g.metric !== 'string') {
            return 'scoringConfig.passPolicy.gates entries need a metric name';
          }
          if (!names.has(g.metric)) {
            return `scoringConfig.passPolicy.gates references unknown metric '${g.metric}'`;
          }
          const def = c.metrics.find(m => m.name === g.metric)!;
          const max = isFiniteNumber(def.scale) ? def.scale : 100;
          if (!isFiniteNumber(g.min) || g.min < 0 || g.min > max) {
            return `scoringConfig.passPolicy.gates '${g.metric}': min must be within the metric scale [0, ${max}]`;
          }
        }
        break;
      }
      default:
        return `scoringConfig.passPolicy.kind must be one of llm-verdict | threshold | gates`;
    }
  }
  return null;
}
