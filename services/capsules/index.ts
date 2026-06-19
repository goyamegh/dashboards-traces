/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capsules — trace-anchored record/replay primitive.
 * Design: https://github.com/opensearch-project/agent-health/issues/323
 */

export {
  CAPSULE_SCHEMA_VERSION,
  CapsuleSchema,
  RecordedTraceSchema,
  IoResponseSchema,
  parseCapsule,
  safeParseCapsule,
} from './schema';
export type {
  Capsule,
  CapsuleBody,
  RecordedTrace,
  RecordedAgainst,
  IoResponse,
  IoKind,
  TurnSource,
  ContractConformance,
  BaselineJudgment,
} from './schema';
export {
  canonicalStringify,
  hashCapsuleBody,
  computeCapsuleHash,
  verifyCapsuleHash,
} from './hash';
export { buildCapsule } from './buildCapsule';
export type { BuildCapsuleOptions } from './buildCapsule';
