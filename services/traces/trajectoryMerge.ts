/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trajectory replacement policy for the trace poller.
 *
 * When an agent's spans arrive, the poller converts them into a trajectory
 * (via the agent's explicit `buildTrajectory` hook, or the default
 * `spansToTrajectory()` conversion) and decides what the judge grades.
 *
 * Policy — **replacement must never lose evidence**:
 *
 *  1. An agent's explicit `buildTrajectory` HOOK is intentional — its output
 *     always wins (issue #320). Callers pass hook output straight through;
 *     this module is not consulted.
 *
 *  2. The DEFAULT span→trajectory conversion is a *best effort* view of the
 *     run. It adds things the connector trajectory lacks (tool calls for
 *     trace-only agents, span timing, gen_ai attributes) but it can also drop
 *     things the connector saw and the spans did not:
 *       - agents whose spans carry no tool payloads yield `tool_result` stubs
 *         ("tool succeeded") or no tool steps at all — while the connector /
 *         afterResponse-hook `tool_result` steps hold the real outputs
 *         (measured live: ~50% of a REST agent's reports ended with NO tool
 *         steps after replacement; the judge wrote "no intermediate
 *         retrieval steps" and graded without evidence);
 *       - Claude Code spans hold prompts/responses in OTel LOGS, so the
 *         span-built trajectory has no `response` content.
 *
 *     So instead of wholesale replacement:
 *       a. **Tool evidence.** If the connector trajectory carries tool
 *          evidence the span trajectory would lose — fewer `action` /
 *          `tool_result` steps, or fewer bytes of `tool_result` evidence
 *          (`toolOutput`, else `content`) — the CONNECTOR trajectory is kept
 *          as the judged trajectory (its ordering of calls, results and
 *          answer is the faithful narrative). Where the span-derived tool
 *          steps line up one-to-one with the connector's, their timing
 *          (`latencyMs`) and tool names are folded onto the connector steps
 *          so the judge still sees per-step latency. The merged tool-step
 *          count is never lower than the connector's, and no `tool_result`
 *          that had an output loses it. Span-only narrative steps (`[LLM …]`
 *          markers, the echoed user prompt) are dropped in this branch — they
 *          carry no evidence. If the connector trajectory has no `response`
 *          content, the span trajectory's answer steps are appended.
 *       b. Otherwise (span tool steps are at least as complete as the
 *          connector's) the span trajectory is used, keeping the #320
 *          behaviour for trace-only agents — and if it has no non-empty
 *          `response` step, the connector's `response` / `assistant` steps
 *          are appended so the judge still sees the agent's actual answer
 *          (pre-existing rule: replacing wholesale with content-less span
 *          stubs failed every case of a live benchmark).
 */

import type { TrajectoryStep } from '@/types';

/** Steps that constitute tool evidence for the judge. */
export const TOOL_STEP_TYPES: ReadonlySet<TrajectoryStep['type']> = new Set(['action', 'tool_result']);

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * The evidence text a `tool_result` step contributes to the judge: its
 * `toolOutput` when non-empty, else its `content`. Empty for non-result steps.
 */
export function toolEvidenceText(step: TrajectoryStep | undefined | null): string {
  if (!step || step.type !== 'tool_result') return '';
  const out = stringify(step.toolOutput).trim();
  // `{}` / `[]` are empty payloads, not evidence.
  if (out && out !== '{}' && out !== '[]') return out;
  return typeof step.content === 'string' ? step.content.trim() : '';
}

/** Does this `tool_result` carry an actual output payload (not a stub)? */
export function hasToolOutput(step: TrajectoryStep | undefined | null): boolean {
  if (!step || step.type !== 'tool_result') return false;
  const out = stringify(step.toolOutput).trim();
  return out.length > 0 && out !== '{}' && out !== '[]';
}

function toolSteps(trajectory: readonly TrajectoryStep[]): TrajectoryStep[] {
  return trajectory.filter((s) => s && TOOL_STEP_TYPES.has(s.type));
}

/** Total bytes of `tool_result` evidence in a trajectory. */
export function toolEvidenceChars(trajectory: readonly TrajectoryStep[]): number {
  return trajectory.reduce((sum, s) => sum + toolEvidenceText(s).length, 0);
}

/**
 * Would replacing `connector` with `span` lose tool evidence?
 *
 * True when the connector has tool steps and either (a) the span trajectory
 * has fewer tool steps, or (b) the span trajectory carries fewer bytes of
 * `tool_result` evidence than the connector's (e.g. "tool succeeded" stubs
 * standing in for multi-KB retrieval results).
 */
export function spanTrajectoryLosesToolEvidence(
  connector: readonly TrajectoryStep[],
  span: readonly TrajectoryStep[],
): boolean {
  const connectorTools = toolSteps(connector);
  if (connectorTools.length === 0) return false;
  if (toolSteps(span).length < connectorTools.length) return true;
  return toolEvidenceChars(span) < toolEvidenceChars(connector);
}

/**
 * Build the trajectory the judge grades from the DEFAULT span-derived
 * trajectory and the connector (pre-poll) trajectory. See the module doc for
 * the policy. Hook-built trajectories must bypass this.
 */
export function mergeSpanTrajectory(
  connector: readonly TrajectoryStep[] | undefined | null,
  span: readonly TrajectoryStep[],
): TrajectoryStep[] {
  const original = connector ?? [];
  if (span.length === 0) return [...original];

  if (spanTrajectoryLosesToolEvidence(original, span)) {
    // (a) Keep the connector's evidence. Fold span timing / tool names onto
    // the connector's tool steps when the two tool sequences have the same
    // shape (same count and step types in order).
    const connectorTools = toolSteps(original);
    const spanTools = toolSteps(span);
    const sameShape =
      spanTools.length === connectorTools.length &&
      spanTools.every((s, i) => s.type === connectorTools[i].type);
    if (!sameShape) return appendAnswerIfMissing([...original], span);

    let toolIdx = 0;
    const kept = original.map((step) => {
      if (!TOOL_STEP_TYPES.has(step.type)) return step;
      const from = spanTools[toolIdx++];
      const out: TrajectoryStep = { ...step };
      if (out.latencyMs == null && from.latencyMs != null) out.latencyMs = from.latencyMs;
      if (!out.toolName && from.toolName) out.toolName = from.toolName;
      return out;
    });
    return appendAnswerIfMissing(kept, span);
  }

  // (b) Span trajectory wins; append the connector's answer if the spans
  // carry no response content.
  return appendAnswerIfMissing([...span], original);
}

/**
 * If `base` has no non-empty `response` step, append `other`'s non-empty
 * `response` / `assistant` steps so the judge always sees the agent's answer.
 */
function appendAnswerIfMissing(base: TrajectoryStep[], other: readonly TrajectoryStep[]): TrajectoryStep[] {
  const hasResponse = base.some(
    (st) => st?.type === 'response' && typeof st.content === 'string' && st.content.trim().length > 0,
  );
  if (hasResponse) return base;
  const answers = other.filter(
    (st) =>
      (st?.type === 'response' || st?.type === 'assistant') &&
      typeof st.content === 'string' &&
      st.content.trim().length > 0,
  );
  return answers.length > 0 ? [...base, ...answers] : base;
}
