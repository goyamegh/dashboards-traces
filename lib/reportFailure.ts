/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read helpers for a report whose run FAILED at a stage (agent request /
 * judge / trace). Pure + dependency-free so both the browser bundle and the
 * server can use them.
 */

import type { AgentErrorInfo, EvaluationReport, FailureStage } from '@/types';

/** The explicit stage written by `buildEvaluatorErrorPatch()`; undefined for healthy or pre-fix reports. */
export function getFailureStage(report: Pick<EvaluationReport, 'failureStage'> | null | undefined): FailureStage | undefined {
  const s = report?.failureStage;
  return s === 'agent' || s === 'judge' || s === 'trace' ? s : undefined;
}

/** True when the agent produced no output at all (nothing to judge). */
export function agentProducedNoOutput(report: Pick<EvaluationReport, 'trajectory' | 'rawEvents'> | null | undefined): boolean {
  if (!report) return true;
  const traj = Array.isArray(report.trajectory) ? report.trajectory.length : 0;
  const raw = Array.isArray(report.rawEvents) ? report.rawEvents.length : 0;
  return traj === 0 && raw === 0;
}

/** Human label for an agent-error kind. */
export function describeAgentErrorKind(kind: AgentErrorInfo['kind'] | undefined): string {
  if (kind === 'timeout') return 'agent request timed out';
  if (kind === 'connection') return 'could not connect to the agent';
  if (kind?.startsWith('http_')) return `agent returned HTTP ${kind.slice(5)}`;
  return 'no response';
}

/** Format ms as a compact human duration ("820 ms", "4.5 s", "4 min 31 s"). */
export function formatMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return rs ? `${m} min ${rs} s` : `${m} min`;
}
