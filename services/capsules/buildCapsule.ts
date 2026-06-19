/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capsule assembly from a session's spans (the *record* half).
 *
 * Given the OTel spans a session emitted, assemble a trace-anchored,
 * content-addressed Capsule. This captures the trace substrate + metadata;
 * freezing external I/O (`io_responses`) happens at agent-run time via the
 * record middleware (the next layer), so a capsule built from *existing* spans
 * starts with an empty `io_responses` — it is still a valid, hashable,
 * replay-targetable artifact for trace-shape comparison.
 *
 * Pure / I/O-free: callers fetch the spans (CLI via ApiClient, route via the
 * observability client) and hand them here, guaranteeing identical capsules
 * across surfaces.
 */

import type { Span } from '@/types';
import { CAPSULE_SCHEMA_VERSION, type Capsule, type CapsuleBody } from './schema';
import { hashCapsuleBody } from './hash';

export interface BuildCapsuleOptions {
  testCaseId: string;
  testCaseVersion?: number;
  spans: Span[];
  agent: string;
  rev: string;
  model?: string;
  configHash?: string;
  /** ISO-8601; defaults to now. Pass explicitly for deterministic tests. */
  recordedAt?: string;
}

/**
 * Assemble a Capsule from a session's spans.
 *
 * @throws if `spans` is empty (a capsule must anchor to at least one span).
 */
export function buildCapsule(opts: BuildCapsuleOptions): Capsule {
  if (!opts.spans || opts.spans.length === 0) {
    throw new Error('Cannot build a capsule from zero spans.');
  }

  // A coding-agent session can span multiple traces; anchor on the trace with
  // the most spans (the primary interaction), but capture every span.
  const counts = new Map<string, number>();
  for (const s of opts.spans) {
    if (s.traceId) counts.set(s.traceId, (counts.get(s.traceId) ?? 0) + 1);
  }
  const primaryTraceId =
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? opts.spans[0].traceId;

  const body: CapsuleBody = {
    schema_version: CAPSULE_SCHEMA_VERSION,
    test_case_id: opts.testCaseId,
    ...(opts.testCaseVersion != null ? { test_case_version: opts.testCaseVersion } : {}),
    recorded_against: {
      agent: opts.agent,
      rev: opts.rev,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.configHash ? { config_hash: opts.configHash } : {}),
      recorded_at: opts.recordedAt ?? new Date().toISOString(),
    },
    recorded_trace: {
      trace_id: primaryTraceId,
      spans: opts.spans as CapsuleBody['recorded_trace']['spans'],
    },
    io_responses: [],
  };

  return { ...body, capsule_hash: hashCapsuleBody(body) } as Capsule;
}
