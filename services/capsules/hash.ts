/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capsule content-addressing.
 *
 * The capsule hash is a sha256 over the *canonicalized* capsule body (the
 * capsule minus its own `capsule_hash` field). Canonicalization sorts object
 * keys recursively so the hash is stable regardless of property insertion
 * order — two records of the same trace + I/O produce the same hash, which is
 * what makes capsules content-addressable and dedupable.
 */

import { createHash } from 'crypto';
import type { Capsule, CapsuleBody } from './schema';

/** Recursively sort object keys for a stable serialization. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable JSON string for hashing. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Compute the content hash for a capsule body (everything but the hash field). */
export function hashCapsuleBody(body: CapsuleBody): string {
  return 'sha256:' + createHash('sha256').update(canonicalStringify(body)).digest('hex');
}

/** Strip the hash field and recompute — returns the expected hash for a capsule. */
export function computeCapsuleHash(capsule: Capsule): string {
  const { capsule_hash: _omit, ...body } = capsule;
  return hashCapsuleBody(body as CapsuleBody);
}

/** True iff the capsule's stored hash matches its recomputed content hash. */
export function verifyCapsuleHash(capsule: Capsule): boolean {
  return computeCapsuleHash(capsule) === capsule.capsule_hash;
}
