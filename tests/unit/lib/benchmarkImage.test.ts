/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  canonicalStringify,
  computeImageDigest,
  fingerprintTestCase,
  buildImageDoc,
  imageIdForDigest,
} from '@/lib/benchmarkImage';

const tcA = {
  name: 'tc-a',
  initialPrompt: 'Fix the failing test',
  expectedOutcomes: ['tests pass'],
};
const tcB = {
  name: 'tc-b',
  initialPrompt: 'Explain the bug',
  expectedOutcomes: ['identifies root cause'],
};

describe('canonicalStringify', () => {
  it('serializes objects with sorted keys, recursively', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('drops undefined values but keeps nulls', () => {
    expect(canonicalStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([2, 1])).toBe('[2,1]');
  });
});

describe('fingerprintTestCase', () => {
  it('is content-based: identical content with different storage ids matches', () => {
    const f1 = fingerprintTestCase({ ...tcA, id: 'tc-123' } as any);
    const f2 = fingerprintTestCase({ ...tcA, id: 'tc-456' } as any);
    expect(f1.contentHash).toBe(f2.contentHash);
  });

  it('changes when the prompt changes', () => {
    const f1 = fingerprintTestCase(tcA);
    const f2 = fingerprintTestCase({ ...tcA, initialPrompt: 'Different prompt' });
    expect(f1.contentHash).not.toBe(f2.contentHash);
  });

  it('changes when expected outcomes change', () => {
    const f1 = fingerprintTestCase(tcA);
    const f2 = fingerprintTestCase({ ...tcA, expectedOutcomes: ['something else'] });
    expect(f1.contentHash).not.toBe(f2.contentHash);
  });

  it('changes when the code-import sourceHash changes (SDK body drift)', () => {
    const f1 = fingerprintTestCase({ ...tcA, sourceHash: 'aaa' });
    const f2 = fingerprintTestCase({ ...tcA, sourceHash: 'bbb' });
    expect(f1.contentHash).not.toBe(f2.contentHash);
  });
});

describe('computeImageDigest', () => {
  it('is deterministic: same inputs → same digest', () => {
    const d1 = computeImageDigest({ testCases: [tcA, tcB], evalConditions: { evaluatorId: 'e1' } });
    const d2 = computeImageDigest({ testCases: [tcA, tcB], evalConditions: { evaluatorId: 'e1' } });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-insensitive over test cases', () => {
    const d1 = computeImageDigest({ testCases: [tcA, tcB] });
    const d2 = computeImageDigest({ testCases: [tcB, tcA] });
    expect(d1).toBe(d2);
  });

  it('changes when a test case content changes', () => {
    const d1 = computeImageDigest({ testCases: [tcA, tcB] });
    const d2 = computeImageDigest({ testCases: [tcA, { ...tcB, initialPrompt: 'changed' }] });
    expect(d1).not.toBe(d2);
  });

  it('changes when the evaluator changes (conditions are controls)', () => {
    const d1 = computeImageDigest({ testCases: [tcA], evalConditions: { evaluatorId: 'e1' } });
    const d2 = computeImageDigest({ testCases: [tcA], evalConditions: { evaluatorId: 'e2' } });
    expect(d1).not.toBe(d2);
  });

  it('changes when the judge model changes', () => {
    const d1 = computeImageDigest({ testCases: [tcA], evalConditions: { judgeModelId: 'sonnet' } });
    const d2 = computeImageDigest({ testCases: [tcA], evalConditions: { judgeModelId: 'haiku' } });
    expect(d1).not.toBe(d2);
  });

  it('treats absent and empty eval conditions identically', () => {
    const d1 = computeImageDigest({ testCases: [tcA] });
    const d2 = computeImageDigest({ testCases: [tcA], evalConditions: {} });
    expect(d1).toBe(d2);
  });
});

describe('buildImageDoc', () => {
  it('builds a content-addressed doc with sorted fingerprints', () => {
    const doc = buildImageDoc({
      testCases: [
        { ...tcB, id: 'tc-2' },
        { ...tcA, id: 'tc-1' },
      ],
      evalConditions: { evaluatorId: 'e1' },
      tags: ['coding-eval:v1'],
    });
    expect(doc.docType).toBe('benchmark-image');
    expect(doc.id).toBe(imageIdForDigest(doc.digest));
    expect(doc.testCaseCount).toBe(2);
    expect(doc.tags).toEqual(['coding-eval:v1']);
    expect(doc.evalConditions).toEqual({ evaluatorId: 'e1' });
    // Fingerprints sorted by contentHash
    const hashes = doc.testCaseFingerprints.map((f) => f.contentHash);
    expect([...hashes].sort()).toEqual(hashes);
    // Digest matches computeImageDigest for same inputs
    expect(doc.digest).toBe(
      computeImageDigest({ testCases: [tcA, tcB], evalConditions: { evaluatorId: 'e1' } })
    );
  });
});
