/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Profile assembly — the pure core behind `agent-health profile` and
 * `POST /api/profile`.
 *
 * A "Profile" is a first-class artifact (like a Trace or a Run): given a
 * session's OTel spans and a chosen evaluator (the rubric), it reconstructs
 * the trajectory, runs the deterministic signal scan, and assembles the
 * context a reasoner needs to propose concrete edits to the agent's own
 * codebase.
 *
 * This function is intentionally **pure / I/O-free**: callers fetch the spans
 * and resolve the evaluator (CLI via ApiClient, server route via storage),
 * then hand both here. That guarantees the CLI, the API, the UI panel, and
 * any MCP tool all produce a **byte-identical profile** for the same inputs —
 * the single-source-of-truth principle from docs/ARCHITECTURE.md.
 *
 * Extracted from cli/commands/profile.ts (PR #267) so the assembly is no
 * longer trapped inside the CLI action.
 */

import {
  spansToTrajectory,
  scanSessionSignals,
  type SessionSignal,
} from '@/services/traces/spansToTrajectory';
import type { Evaluator, Span, TrajectoryStep } from '@/types';

/** Options that tune assembly but don't change where the data comes from. */
export interface BuildProfileOptions {
  /**
   * OTel service name used as a *fallback* discriminator when reconstructing
   * the trajectory (native `claude-code` telemetry vs. the `claude-code-agent`
   * connector). Spans are primarily keyed by the globally-unique session id,
   * so this only matters for ambiguous multi-service sessions.
   */
  service?: string;
  /**
   * Optional upfront human steering the traces alone can't capture
   * (e.g. "focus on routing; it ignored the SOP"). Weighted above the
   * deterministic signals by the reasoner.
   */
  userFeedback?: string;
}

/** The Profile artifact. Stable shape — consumed by CLI, API, UI, MCP. */
export interface AgentProfile {
  session: {
    sessionId: string;
    serviceName: string;
    /** Distinct trace ids — the anchor for verifying any finding in the Traces tab. */
    traceIds: string[];
    spanCount: number;
    trajectorySteps: number;
    durationMs: number;
    tokens: number;
  };
  evaluator: {
    id: string;
    name: string;
    systemPrompt: string;
    metrics: unknown[];
    passThreshold?: number;
  };
  signals: SessionSignal[];
  userFeedback?: string;
  trajectory: TrajectoryStep[];
  instructions: string;
}

const DEFAULT_SERVICE = 'claude-code';

/** Sum a numeric span attribute across spans (tolerant of string values). */
function sumAttr(spans: Span[], keys: string[]): number {
  let total = 0;
  for (const s of spans) {
    for (const k of keys) {
      const v = s.attributes?.[k];
      if (v != null && !isNaN(Number(v))) {
        total += Number(v);
        break;
      }
    }
  }
  return total;
}

/**
 * Assemble a Profile from a session's spans + the chosen evaluator (rubric).
 *
 * Pure: no network, no fs, no clock. Deterministic for a given (spans,
 * evaluator, options) triple — which is what makes profiles comparable across
 * agent revisions and reproducible in CI.
 *
 * @throws never — returns an assembled profile even for an empty signal scan.
 *   Callers are responsible for the "no spans" guard (an empty profile is a
 *   valid but useless artifact; the CLI/route reject it upstream).
 */
export function buildProfile(
  sessionId: string,
  spans: Span[],
  evaluator: Evaluator,
  options: BuildProfileOptions = {},
): AgentProfile {
  const service = options.service || DEFAULT_SERVICE;

  const trajectory = spansToTrajectory(spans, service);
  const signals = scanSessionSignals(spans, service);

  const startTimes = spans.map(s => new Date(s.startTime).getTime()).filter(n => !isNaN(n));
  const endTimes = spans.map(s => new Date(s.endTime).getTime()).filter(n => !isNaN(n));
  const durationMs =
    startTimes.length && endTimes.length ? Math.max(...endTimes) - Math.min(...startTimes) : 0;

  const tokens =
    sumAttr(spans, ['gen_ai.usage.input_tokens', 'input_tokens']) +
    sumAttr(spans, ['gen_ai.usage.output_tokens', 'output_tokens']);

  // Report the service name actually seen on the spans (`claude-code` for
  // native telemetry vs `claude-code-agent` for the connector), reading
  // whichever attribute key the span carries.
  const svcSpan = spans.find(s => s.attributes?.['service.name'] || s.attributes?.['serviceName']);
  const observedService = String(
    svcSpan?.attributes?.['service.name'] ?? svcSpan?.attributes?.['serviceName'] ?? service,
  );

  return {
    session: {
      sessionId,
      serviceName: observedService,
      traceIds: [...new Set(spans.map(s => s.traceId).filter(Boolean))],
      spanCount: spans.length,
      trajectorySteps: trajectory.length,
      durationMs,
      tokens,
    },
    evaluator: {
      id: evaluator.id,
      name: evaluator.name,
      systemPrompt: evaluator.systemPrompt,
      metrics: evaluator.scoringConfig?.metrics ?? [],
      passThreshold: evaluator.scoringConfig?.passThreshold,
    },
    signals,
    userFeedback: options.userFeedback || undefined,
    trajectory,
    instructions: buildInstructions(options.userFeedback),
  };
}

/** The reasoner-facing instruction block. Kept here so CLI + API agree verbatim. */
function buildInstructions(userFeedback?: string): string {
  return [
    'You are improving the agent whose session is profiled above, in ITS OWN codebase.',
    userFeedback
      ? `The user gave this upfront feedback — treat it as the PRIMARY lens, above the signals: "${userFeedback}"`
      : 'No upfront user feedback was given; rely on the rubric + signals.',
    'Using the evaluator.systemPrompt as your rubric, review:',
    '  (a) the trajectory below, (b) the signals, (c) the userFeedback (if any),',
    '  (d) the CURRENT CHAT you already have, and (e) the codebase in the cwd.',
    'Produce a prioritized list of concrete edits. For each: the file to change,',
    'what to change, why (tie it to the user feedback, a signal, or a rubric criterion +',
    'cite the evidence: the session.traceIds / the signal that triggered it), and priority.',
    'Make minimal, generalizable changes on a branch — do not edit the working tree directly.',
  ].join('\n');
}
