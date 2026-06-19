/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildCapsule } from '@/services/capsules/buildCapsule';
import { parseCapsule, verifyCapsuleHash } from '@/services/capsules';
import type { Span } from '@/types';

function span(spanId: string, traceId: string): Span {
  return {
    traceId, spanId, name: 'execute_tool',
    startTime: '2026-01-15T22:14:08.000Z', endTime: '2026-01-15T22:14:09.000Z',
    status: 'OK', attributes: { 'gen_ai.tool.name': 'Bash' },
  };
}

const OPTS = {
  testCaseId: 'tc-001', agent: 'rca-bot', rev: 'a1b2c3d',
  recordedAt: '2026-01-15T22:14:31.000Z',
};

describe('buildCapsule', () => {
  it('assembles a valid, hash-verified capsule from spans', () => {
    const capsule = buildCapsule({ ...OPTS, spans: [span('s1', 't1'), span('s2', 't1')] });
    expect(() => parseCapsule(capsule)).not.toThrow();
    expect(verifyCapsuleHash(capsule)).toBe(true);
    expect(capsule.recorded_trace.spans).toHaveLength(2);
    expect(capsule.io_responses).toEqual([]); // record-from-spans starts empty
    expect(capsule.recorded_against.agent).toBe('rca-bot');
  });

  it('anchors on the trace with the most spans for a multi-trace session', () => {
    // t2 has 2 spans, t1 has 1 → primary is t2
    const capsule = buildCapsule({ ...OPTS, spans: [span('a', 't1'), span('b', 't2'), span('c', 't2')] });
    expect(capsule.recorded_trace.trace_id).toBe('t2');
    expect(capsule.recorded_trace.spans).toHaveLength(3); // all spans captured
  });

  it('is deterministic for fixed inputs (same hash)', () => {
    const a = buildCapsule({ ...OPTS, spans: [span('s1', 't1')] });
    const b = buildCapsule({ ...OPTS, spans: [span('s1', 't1')] });
    expect(a.capsule_hash).toBe(b.capsule_hash);
  });

  it('throws on zero spans', () => {
    expect(() => buildCapsule({ ...OPTS, spans: [] })).toThrow(/zero spans/i);
  });
});
