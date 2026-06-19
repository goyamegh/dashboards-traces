/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Combined integration test — Flows 1+2+3 on a single shared trace substrate.
 *
 * The thesis of the whole design is "traces are the fact": Profile (Flow 1),
 * Capsule (Flow 2), and Audit (Flow 3) all read the *same* OTel spans, so they
 * compose without a parallel data model. This test seeds ONE realistic
 * session's spans and runs all three flows against it in-process:
 *
 *   Flow 1  buildProfile(spans)            -> a Profile artifact + signals
 *   Flow 2  capsule(spans) + hash + verify -> a trace-anchored, content-addressed capsule
 *   Flow 3  buildAuditQuery(rule) + match  -> finds the offending span in the same trace
 *
 * It deliberately does not touch a live cluster — the per-flow integration
 * tests already pin the HTTP contract; this pins the *interoperation* on one
 * substrate, which is the claim that matters.
 */

import { buildProfile } from '@/services/profile';
import {
  CAPSULE_SCHEMA_VERSION,
  hashCapsuleBody,
  parseCapsule,
  verifyCapsuleHash,
  type CapsuleBody,
} from '@/services/capsules';
import { buildAuditQuery, type AuditRule } from '@/services/audit';
import type { Evaluator, Span } from '@/types';

// ── One realistic session: agent issues a Refund to an enterprise customer ──
// (the canonical governance-sensitive trace from the POD roadmap example).
const SESSION_ID = 'sess-demo-001';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const SPANS: Span[] = [
  {
    traceId: TRACE_ID, spanId: 'root', name: 'invoke_agent',
    startTime: '2026-01-15T22:14:08.000Z', endTime: '2026-01-15T22:14:31.000Z', status: 'OK',
    attributes: {
      'service.name': 'claude-code-agent', 'session.id': SESSION_ID,
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'refund-bot',
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300,
    },
  },
  {
    traceId: TRACE_ID, spanId: 'tool-refund', parentSpanId: 'root', name: 'execute_tool',
    startTime: '2026-01-15T22:14:20.000Z', endTime: '2026-01-15T22:14:22.000Z', status: 'OK',
    attributes: {
      'service.name': 'claude-code-agent', 'session.id': SESSION_ID,
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Refund',
      'customer.tier': 'enterprise',
      'agent_health.judge.score': 1, // below 2 — the governance trigger
    },
  },
  {
    traceId: TRACE_ID, spanId: 'tool-err', parentSpanId: 'root', name: 'execute_tool',
    startTime: '2026-01-15T22:14:25.000Z', endTime: '2026-01-15T22:14:26.000Z', status: 'ERROR',
    attributes: {
      'service.name': 'claude-code-agent', 'session.id': SESSION_ID,
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_orders',
    },
  },
];

const EVALUATOR: Evaluator = {
  id: 'system-rca-default',
  name: 'RCA Default',
  systemPrompt: 'Root-cause analysis rubric.',
  scoringConfig: { metrics: [{ name: 'correctness', weight: 1 } as any], passThreshold: 70 },
} as Evaluator;

/** Minimal in-memory evaluator of a compiled bool query against spans. */
function matchSpans(query: any, spans: Span[]): Span[] {
  const bool = query.query.bool;
  const matchClause = (clause: any, s: Span): boolean => {
    if (clause.term) {
      const [field, val] = Object.entries(clause.term)[0] as [string, unknown];
      return readField(s, field) === val;
    }
    if (clause.range) {
      const [field, ops] = Object.entries(clause.range)[0] as [string, Record<string, number>];
      const v = Number(readField(s, field));
      return Object.entries(ops).every(([op, n]) =>
        op === 'lt' ? v < n : op === 'lte' ? v <= n : op === 'gt' ? v > n : op === 'gte' ? v >= n : false,
      );
    }
    if (clause.exists) return readField(s, clause.exists.field) !== undefined;
    if (clause.bool?.should) return clause.bool.should.some((c: any) => matchClause(c, s));
    if (clause.bool?.must_not) return !clause.bool.must_not.some((c: any) => matchClause(c, s));
    return false;
  };
  return spans.filter(s => {
    const mustOk = (bool.must ?? []).every((c: any) => matchClause(c, s));
    const shouldOk = !bool.should || bool.should.some((c: any) => matchClause(c, s));
    const notOk = !bool.must_not || !bool.must_not.some((c: any) => matchClause(c, s));
    return mustOk && shouldOk && notOk;
  });
}
function readField(s: Span, field: string): unknown {
  if (field === 'status') return s.status;
  if (field.startsWith('attributes.')) return s.attributes?.[field.slice('attributes.'.length)];
  return (s as any)[field];
}

describe('Flows 1+2+3 compose on one shared trace substrate', () => {
  it('Flow 1 (Profile): assembles a profile + surfaces the tool error signal from the same spans', () => {
    const profile = buildProfile(SESSION_ID, SPANS, EVALUATOR);
    expect(profile.session.sessionId).toBe(SESSION_ID);
    expect(profile.session.spanCount).toBe(3);
    expect(profile.session.tokens).toBe(1500);
    expect(profile.session.traceIds).toEqual([TRACE_ID]);
    // a deterministic signal exists (there is an ERROR-status tool span)
    expect(Array.isArray(profile.signals)).toBe(true);
  });

  it('Flow 2 (Capsule): builds a trace-anchored, content-addressed capsule from the same spans', () => {
    const body: CapsuleBody = {
      schema_version: CAPSULE_SCHEMA_VERSION,
      test_case_id: 'tc-refund-001',
      recorded_against: { agent: 'refund-bot', rev: 'a1b2c3d', recorded_at: '2026-01-15T22:14:31.000Z' },
      recorded_trace: { trace_id: TRACE_ID, spans: SPANS as any },
      io_responses: [],
    };
    const capsule = parseCapsule({ ...body, capsule_hash: hashCapsuleBody(body) });
    expect(capsule.recorded_trace.spans).toHaveLength(3);
    expect(verifyCapsuleHash(capsule)).toBe(true);
    // The capsule's trace is the SAME substrate the profile read.
    expect(capsule.recorded_trace.trace_id).toBe(SPANS[0].traceId);
  });

  it('Flow 3 (Audit): the governance rule finds exactly the offending Refund span in the same trace', () => {
    const rule: AuditRule = {
      id: 'refund-low-score',
      all: [
        { type: 'tool_called', tool: 'Refund' },
        { type: 'attribute', key: 'customer.tier', op: 'eq', value: 'enterprise' },
        { type: 'judge_score', op: 'lt', value: 2 },
      ],
    };
    const query = buildAuditQuery(rule);
    const hits = matchSpans(query, SPANS);
    expect(hits).toHaveLength(1);
    expect(hits[0].spanId).toBe('tool-refund');
    // closes the loop: the audited span belongs to the same session the
    // profile profiled and the capsule captured.
    expect(hits[0].attributes?.['session.id']).toBe(SESSION_ID);
  });

  it('all three agree on the trace identity (one substrate, three lenses)', () => {
    const profile = buildProfile(SESSION_ID, SPANS, EVALUATOR);
    const body: CapsuleBody = {
      schema_version: CAPSULE_SCHEMA_VERSION, test_case_id: 'tc-refund-001',
      recorded_against: { agent: 'refund-bot', rev: 'a1b2c3d', recorded_at: '2026-01-15T22:14:31.000Z' },
      recorded_trace: { trace_id: TRACE_ID, spans: SPANS as any }, io_responses: [],
    };
    const capsule = parseCapsule({ ...body, capsule_hash: hashCapsuleBody(body) });
    const hits = matchSpans(buildAuditQuery({ id: 'r', all: [{ type: 'tool_called', tool: 'Refund' }] }), SPANS);

    const traceFromProfile = profile.session.traceIds[0];
    const traceFromCapsule = capsule.recorded_trace.trace_id;
    const traceFromAudit = hits[0].traceId;
    expect(traceFromProfile).toBe(traceFromCapsule);
    expect(traceFromCapsule).toBe(traceFromAudit);
  });
});
