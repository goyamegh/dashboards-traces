/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Audit — "did my agent ever do something it shouldn't have?" (Flow 3).
 */

export { buildAuditQuery, clauseToQuery, otelSpanFieldMapper } from './auditQuery';
export type { AuditRule, AuditClause, AuditOp, FieldMapper } from './auditQuery';
