/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark images — content-addressed identity for evaluation conditions.
 *
 * An image freezes the "controls" of an evaluation run: the test-case
 * contents and the eval conditions (evaluator, judge model). The digest is a
 * SHA-256 over a canonical serialization, so:
 *
 *   - two runs with the same digest are comparable **by construction**
 *     (same tests, same judge conditions — only the agent varies);
 *   - re-running the same command yields the same digest → the image is
 *     found, not re-created (inherent dedup: identity is content, not name).
 *
 * Names are docker-style *tags*: mutable labels pointing at a digest, never
 * identity. See the benchmark-dedup design discussion for rationale.
 */

import { createHash } from 'crypto';
import type { BenchmarkImage, TestCase } from '@/types';

/** Eval conditions frozen into an image digest. */
export interface ImageEvalConditions {
  evaluatorId?: string;
  judgeModelId?: string;
}

/** Bump when the digest input shape changes (invalidates old digests). */
export const IMAGE_DIGEST_VERSION = 1;

/**
 * Deterministic JSON: objects serialized with sorted keys, recursively.
 * Arrays keep their order (order-sensitivity is decided by the caller).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Content fingerprint of a single test case. Uses CONTENT only — never the
 * storage id — so re-imported test cases (fresh ids, same content) fingerprint
 * identically. Fields chosen to match what actually changes agent behavior
 * and judging: prompt, context, expected outcomes/trajectory, tools.
 */
export function fingerprintTestCase(
  tc: Partial<TestCase> & { name: string }
): { name: string; contentHash: string } {
  const content = {
    name: tc.name,
    initialPrompt: tc.initialPrompt ?? null,
    context: tc.context ?? null,
    tools: tc.tools ?? null,
    expectedOutcomes: tc.expectedOutcomes ?? null,
    expectedTrajectory: tc.expectedTrajectory ?? null,
    // Code-imported cases: sourceHash already fingerprints the executable body.
    sourceHash: tc.sourceHash ?? null,
  };
  return { name: tc.name, contentHash: sha256Hex(canonicalStringify(content)) };
}

/**
 * Compute the image digest for a set of test cases + eval conditions.
 * Order-insensitive over test cases (fingerprints are sorted), content- and
 * condition-sensitive.
 */
export function computeImageDigest(input: {
  testCases: Array<Partial<TestCase> & { name: string }>;
  evalConditions?: ImageEvalConditions;
}): string {
  const fingerprints = input.testCases
    .map(fingerprintTestCase)
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const payload = {
    v: IMAGE_DIGEST_VERSION,
    testCases: fingerprints.map((f) => f.contentHash),
    evalConditions: {
      evaluatorId: input.evalConditions?.evaluatorId ?? null,
      judgeModelId: input.evalConditions?.judgeModelId ?? null,
    },
  };
  return sha256Hex(canonicalStringify(payload));
}

/** Storage id for an image doc (content-addressed — one doc per digest). */
export function imageIdForDigest(digest: string): string {
  return `img-${digest}`;
}

/**
 * Build a full image doc for storage. `create` on the storage side is
 * find-or-create keyed on the digest, so calling this repeatedly for the
 * same inputs is harmless.
 */
export function buildImageDoc(input: {
  testCases: Array<Partial<TestCase> & { id?: string; name: string }>;
  evalConditions?: ImageEvalConditions;
  tags?: string[];
}): BenchmarkImage {
  const digest = computeImageDigest(input);
  const fingerprints = input.testCases
    .map((tc) => ({ ...fingerprintTestCase(tc), id: tc.id }))
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  return {
    id: imageIdForDigest(digest),
    docType: 'benchmark-image',
    digest,
    tags: input.tags ?? [],
    testCaseFingerprints: fingerprints,
    testCaseCount: fingerprints.length,
    evalConditions: {
      ...(input.evalConditions?.evaluatorId ? { evaluatorId: input.evalConditions.evaluatorId } : {}),
      ...(input.evalConditions?.judgeModelId ? { judgeModelId: input.evalConditions.judgeModelId } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}
