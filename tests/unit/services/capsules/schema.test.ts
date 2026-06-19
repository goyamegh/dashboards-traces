/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseCapsule,
  safeParseCapsule,
  CAPSULE_SCHEMA_VERSION,
  type Capsule,
  type CapsuleBody,
} from '@/services/capsules/schema';
import {
  hashCapsuleBody,
  computeCapsuleHash,
  verifyCapsuleHash,
  canonicalStringify,
} from '@/services/capsules/hash';

function makeBody(overrides: Partial<CapsuleBody> = {}): CapsuleBody {
  return {
    schema_version: CAPSULE_SCHEMA_VERSION,
    test_case_id: 'tc-rca-001',
    test_case_version: 7,
    recorded_against: {
      agent: 'rca-bot',
      rev: 'a1b2c3d',
      model: 'anthropic.claude-sonnet-4',
      recorded_at: '2026-01-15T22:14:08.000Z',
    },
    recorded_trace: {
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      spans: [
        {
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          name: 'invoke_agent',
          startTime: '2026-01-15T22:14:08.000Z',
          endTime: '2026-01-15T22:14:31.000Z',
          status: 'OK',
          attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'rca-bot' },
        },
      ],
    },
    io_responses: [
      {
        span_id: '1f1d2e3a4b5c6d7e',
        kind: 'llm_response',
        request_canonical_hash: 'sha256:e1f2a3',
        response: { content: [{ type: 'text', text: 'checking logs' }], usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ],
    ...overrides,
  };
}

function makeCapsule(overrides: Partial<CapsuleBody> = {}): Capsule {
  const body = makeBody(overrides);
  return { ...body, capsule_hash: hashCapsuleBody(body) } as Capsule;
}

describe('capsule schema (v1)', () => {
  it('parses a well-formed capsule', () => {
    const capsule = makeCapsule();
    expect(() => parseCapsule(capsule)).not.toThrow();
    expect(parseCapsule(capsule).schema_version).toBe('1.0');
  });

  it('rejects an unknown schema_version', () => {
    const bad = { ...makeCapsule(), schema_version: '2.0' };
    expect(safeParseCapsule(bad).success).toBe(false);
  });

  it('rejects a recorded_trace with zero spans', () => {
    const bad = makeBody();
    (bad.recorded_trace as any).spans = [];
    expect(safeParseCapsule({ ...bad, capsule_hash: 'sha256:x' }).success).toBe(false);
  });

  it('rejects a missing test_case_id', () => {
    const body = makeBody();
    delete (body as any).test_case_id;
    expect(safeParseCapsule({ ...body, capsule_hash: 'sha256:x' }).success).toBe(false);
  });

  it('preserves forward-compat span fields via passthrough (events, children)', () => {
    const body = makeBody();
    (body.recorded_trace.spans[0] as any).events = [{ name: 'tool.input', time: 't', attributes: {} }];
    const capsule = { ...body, capsule_hash: hashCapsuleBody(body) };
    const parsed = parseCapsule(capsule);
    expect((parsed.recorded_trace.spans[0] as any).events).toHaveLength(1);
  });
});

describe('capsule content-addressing', () => {
  it('hash is stable regardless of key insertion order', () => {
    const a = makeBody();
    // Rebuild with keys in a different order
    const b: CapsuleBody = {
      io_responses: a.io_responses,
      recorded_trace: a.recorded_trace,
      recorded_against: a.recorded_against,
      test_case_version: a.test_case_version,
      test_case_id: a.test_case_id,
      schema_version: a.schema_version,
    };
    expect(hashCapsuleBody(a)).toBe(hashCapsuleBody(b));
  });

  it('verifyCapsuleHash is true for a freshly built capsule', () => {
    expect(verifyCapsuleHash(makeCapsule())).toBe(true);
  });

  it('verifyCapsuleHash is false when the body is tampered after hashing', () => {
    const capsule = makeCapsule();
    const tampered = { ...capsule, test_case_id: 'tc-tampered' };
    expect(verifyCapsuleHash(tampered)).toBe(false);
  });

  it('computeCapsuleHash ignores the existing capsule_hash field', () => {
    const capsule = makeCapsule();
    const withWrongHash = { ...capsule, capsule_hash: 'sha256:bogus' };
    // Recomputed hash should equal the original correct hash, not the bogus one
    expect(computeCapsuleHash(withWrongHash)).toBe(capsule.capsule_hash);
  });

  it('canonicalStringify sorts nested keys deterministically', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
