/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Audit rules — "did my agent ever do something it shouldn't have?"
 *
 * An AuditRule expresses a governance question as structured data, e.g.
 * "every trace where the agent called the Refund tool on an enterprise
 * customer but the judge scored below 2 in the last 30 days". `buildAuditQuery`
 * compiles a rule into an OpenSearch query DSL body over the spans index — the
 * deterministic core of Flow 3 (audit). At PB scale this is a search problem,
 * which is OpenSearch's home turf; expressing the rule as data (not a hand-
 * written DSL) is what lets a non-engineer define one and lets us unit-test the
 * compilation without a cluster.
 *
 * Clauses map onto OTel GenAI semconv attributes the rest of Agent Health
 * already indexes (`gen_ai.tool.name`, span status, arbitrary `attributes.*`),
 * so audit reads the same trace facts used everywhere else — no parallel model.
 */

/** Comparison operators for numeric / value clauses. */
export type AuditOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

/** A single condition over a span. */
export type AuditClause =
  | { type: 'tool_called'; tool: string }
  | { type: 'span_status'; status: 'OK' | 'ERROR' | 'UNSET' }
  | { type: 'attribute'; key: string; op: AuditOp; value?: string | number | boolean }
  | { type: 'judge_score'; op: Exclude<AuditOp, 'exists'>; value: number };

/** A governance rule: AND of `all`, OR of `any`, NOT of `none`, within `window`. */
export interface AuditRule {
  id: string;
  name?: string;
  /** Time window on span start timestamp (ISO-8601 strings). */
  window?: { gte?: string; lte?: string };
  /** All must match (AND). */
  all?: AuditClause[];
  /** At least one must match (OR). */
  any?: AuditClause[];
  /** None may match (NOT). */
  none?: AuditClause[];
}

/** The attribute key a judge score is recorded under on eval spans. */
const JUDGE_SCORE_ATTR = 'agent_health.judge.score';
/**
 * Attribute keys a tool name can live under, in priority order: OTel GenAI
 * semconv first, then the native `tool_name` many agents (e.g. Claude Code)
 * actually emit. `tool_called` unions over all of these so a rule matches
 * regardless of the agent's telemetry flavour (mirrors the fallback in
 * services/traces/spanCategorization.ts).
 */
const TOOL_NAME_KEYS = ['gen_ai.tool.name', 'tool_name'];
/** Span start time field in the OTel spans index. */
const START_TIME_FIELD = 'startTime';

/**
 * Maps a *logical* field reference to the actual indexed field path.
 *
 * `buildAuditQuery` is schema-agnostic: it emits logical paths
 * (`attributes.<key>`, `status`, `startTime`). The caller injects a mapper for
 * the index it queries. The default is identity (handy for tests and for any
 * store that indexes the normalized shape). The OTel span index uses a
 * different physical layout, so the route passes `otelSpanFieldMapper`.
 */
export type FieldMapper = (logicalField: string) => string;

const identityMapper: FieldMapper = (f) => f;

/**
 * Field mapper for the `otel-v1-apm-span-*` index (Data Prepper layout):
 * `attributes.gen_ai.tool.name` -> `span.attributes.gen_ai@tool@name`
 * `status` -> `status` · `startTime` -> `startTime`.
 *
 * NOTE: `span.attributes.*` fields are already keyword-mapped in this index, so
 * `term` queries target them directly (no `.keyword` subfield) — confirmed
 * against the same query construction `fetchTraces` uses for sessionId / runId.
 */
export const otelSpanFieldMapper: FieldMapper = (logicalField) => {
  if (logicalField === START_TIME_FIELD) return logicalField;
  // Span status is stored as a numeric code at `status.code` (2=ERROR, 1=OK,
  // 0/absent=UNSET), not a top-level string — see transformSpan in
  // server/services/tracesService.ts. clauseToQuery translates the value to
  // match when it sees this mapped field.
  if (logicalField === 'status') return 'status.code';
  if (logicalField.startsWith('attributes.')) {
    const key = logicalField.slice('attributes.'.length).replace(/\./g, '@');
    return `span.attributes.${key}`;
  }
  return logicalField;
};

/** OTel span status string -> numeric status.code (Data Prepper layout). */
const STATUS_CODE: Record<'UNSET' | 'OK' | 'ERROR', number> = { UNSET: 0, OK: 1, ERROR: 2 };

/** A `should`-union of `term` matches over several candidate fields (OR). */
function anyOf(fields: string[], value: unknown): Record<string, unknown> {
  if (fields.length === 1) return { term: { [fields[0]]: value } };
  return { bool: { should: fields.map((f) => ({ term: { [f]: value } })), minimum_should_match: 1 } };
}

/** Compile one clause into an OpenSearch query fragment. */
export function clauseToQuery(clause: AuditClause, mapField: FieldMapper = identityMapper): Record<string, unknown> {
  switch (clause.type) {
    case 'tool_called':
      return anyOf(TOOL_NAME_KEYS.map((k) => mapField(`attributes.${k}`)), clause.tool);

    case 'span_status': {
      const field = mapField('status');
      // When the index stores status as a numeric code (`status.code`),
      // translate the logical string to that code; otherwise match the string.
      const value = field === 'status.code' ? STATUS_CODE[clause.status] : clause.status;
      return { term: { [field]: value } };
    }

    case 'judge_score':
      return { range: { [mapField(`attributes.${JUDGE_SCORE_ATTR}`)]: { [clause.op]: clause.value } } };

    case 'attribute': {
      const field = mapField(`attributes.${clause.key}`);
      if (clause.op === 'exists') return { exists: { field } };
      if (clause.op === 'eq') return { term: { [field]: clause.value } };
      if (clause.op === 'ne') return { bool: { must_not: [{ term: { [field]: clause.value } }] } };
      // gt/gte/lt/lte -> range
      return { range: { [field]: { [clause.op]: clause.value } } };
    }

    default: {
      // Exhaustiveness guard - a new clause type must be handled above.
      const _never: never = clause;
      throw new Error(`Unhandled audit clause: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Compile an AuditRule into an OpenSearch query DSL `{ query: {...} }` body.
 * Pure and deterministic — same rule always produces the same query.
 *
 * @throws if the rule has no conditions at all (would scan the whole index).
 */
export function buildAuditQuery(rule: AuditRule, mapField: FieldMapper = identityMapper): { query: Record<string, unknown> } {
  const must: Record<string, unknown>[] = [];
  const should: Record<string, unknown>[] = [];
  const mustNot: Record<string, unknown>[] = [];

  for (const c of rule.all ?? []) must.push(clauseToQuery(c, mapField));
  for (const c of rule.any ?? []) should.push(clauseToQuery(c, mapField));
  for (const c of rule.none ?? []) mustNot.push(clauseToQuery(c, mapField));

  const filter: Record<string, unknown>[] = [];
  if (rule.window && (rule.window.gte || rule.window.lte)) {
    const range: Record<string, string> = {};
    if (rule.window.gte) range.gte = rule.window.gte;
    if (rule.window.lte) range.lte = rule.window.lte;
    filter.push({ range: { [mapField(START_TIME_FIELD)]: range } });
  }

  const hasConditions = must.length || should.length || mustNot.length || filter.length;
  if (!hasConditions) {
    throw new Error(`Audit rule "${rule.id}" has no conditions — refusing to build a full-index scan.`);
  }

  const bool: Record<string, unknown> = {};
  if (must.length) bool.must = must;
  if (should.length) {
    bool.should = should;
    bool.minimum_should_match = 1;
  }
  if (mustNot.length) bool.must_not = mustNot;
  if (filter.length) bool.filter = filter;

  return { query: { bool } };
}
