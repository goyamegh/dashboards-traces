/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retrieval (database / search) span helpers.
 *
 * Extracts the display-worthy input/output of a span that follows the OTel
 * database semantic conventions — the query that was sent and what came back.
 *
 * Input:  `db.query.text` (Recommended; legacy `db.statement`), pretty-printed
 *         when it is JSON, captioned with `db.operation.name` and the target
 *         (`db.collection.name`, falling back to `db.namespace`).
 * Output: `db.response.returned_rows` and `db.response.status_code`, plus any
 *         retrieved-id list the instrumentation chose to record.
 *
 * ## Id-list convention
 *
 * The DB conventions have no attribute for "which documents came back", yet
 * that is exactly what a retrieval-quality judge needs. Agents can expose it
 * with ANY attribute whose key ends in `.hit_ids` or `.result_ids`, or the
 * neutral key `retrieval.ids` — e.g. `myagent.search.hit_ids`. The value may
 * be an OTel string array or a stringified list (JSON, or a language-native
 * repr such as `['a', 'b']`). Nothing here is specific to one agent.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */

import { Span } from '@/types';
import {
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_SYSTEM,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_STATEMENT,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_DB_COLLECTION_NAME,
  ATTR_DB_RESPONSE_RETURNED_ROWS,
  ATTR_DB_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions/incubating';

export interface RetrievalIdList {
  /** The attribute the ids were read from (e.g. `myagent.search.hit_ids`). */
  attribute: string;
  ids: string[];
}

export interface RetrievalIO {
  /** `db.system.name` (or legacy `db.system`). */
  system: string | null;
  /** `db.operation.name`. */
  operation: string | null;
  /** `db.collection.name`, falling back to `db.namespace`. */
  target: string | null;
  /** `db.namespace` (database / index namespace), when distinct from target. */
  namespace: string | null;
  /** One-line caption: `search products (opensearch)`. */
  caption: string | null;
  /** Query text, pretty-printed when it parses as JSON. Null when absent. */
  queryText: string | null;
  /** `db.response.returned_rows` as a number when parseable. */
  returnedRows: number | null;
  /** `db.response.status_code` verbatim. */
  statusCode: string | null;
  /** Retrieved-id lists found via the `*.hit_ids` / `*.result_ids` / `retrieval.ids` convention. */
  idLists: RetrievalIdList[];
  /** Human-readable output block (rows, status, ids) or null when nothing is known. */
  outputText: string | null;
}

/** Attribute keys that carry retrieved ids (see module doc). */
const ID_LIST_KEY_RE = /(^|\.)(hit_ids|result_ids)$/;
const ID_LIST_EXACT_KEY = 'retrieval.ids';

export function isRetrievalIdListKey(key: string): boolean {
  return key === ID_LIST_EXACT_KEY || ID_LIST_KEY_RE.test(key);
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'string' ? v : String(v);
}

/** Pretty-print JSON-shaped text; return other text verbatim. */
export function prettyPrintIfJson(text: string): string {
  const trimmed = text.trim();
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksJson) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/**
 * Coerce an id-list attribute value into `string[]`.
 * Accepts arrays, JSON arrays as text, and bracketed lists with quoted or
 * bare comma-separated items (e.g. a Python `repr`).
 */
export function parseIdList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(v => v.length > 0);
  }
  if (typeof value !== 'string') return [String(value)];
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(v => String(v)).filter(v => v.length > 0);
  } catch {
    /* not JSON — fall through to the lenient parser */
  }
  const inner = trimmed.replace(/^[\[(]/, '').replace(/[\])]$/, '');
  return inner
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(part => part.length > 0);
}

/** Collect every id list on the span following the convention. */
export function extractRetrievalIdLists(span: Span): RetrievalIdList[] {
  const attrs = span.attributes || {};
  const lists: RetrievalIdList[] = [];
  for (const key of Object.keys(attrs)) {
    if (!isRetrievalIdListKey(key)) continue;
    const ids = parseIdList(attrs[key]);
    if (ids.length > 0) lists.push({ attribute: key, ids });
  }
  return lists;
}

/**
 * Extract the retrieval input/output of a DB-semconv span. Works on any span —
 * fields are null when the attributes are absent — so callers can use it as a
 * fallback without first checking the category.
 */
export function extractRetrievalIO(span: Span): RetrievalIO {
  const attrs = span.attributes || {};

  const system = toStr(attrs[ATTR_DB_SYSTEM_NAME] ?? attrs[ATTR_DB_SYSTEM]);
  const operation = toStr(attrs[ATTR_DB_OPERATION_NAME]);
  const collection = toStr(attrs[ATTR_DB_COLLECTION_NAME]);
  const namespace = toStr(attrs[ATTR_DB_NAMESPACE]);
  const target = collection ?? namespace;

  const rawQuery = attrs[ATTR_DB_QUERY_TEXT] ?? attrs[ATTR_DB_STATEMENT];
  let queryText: string | null = null;
  if (rawQuery !== null && rawQuery !== undefined && rawQuery !== '') {
    queryText = typeof rawQuery === 'string'
      ? prettyPrintIfJson(rawQuery)
      : JSON.stringify(rawQuery, null, 2);
  }

  const rowsRaw = attrs[ATTR_DB_RESPONSE_RETURNED_ROWS];
  const rowsNum = rowsRaw === null || rowsRaw === undefined || rowsRaw === '' ? NaN : Number(rowsRaw);
  const returnedRows = Number.isFinite(rowsNum) ? rowsNum : null;
  const statusCode = toStr(attrs[ATTR_DB_RESPONSE_STATUS_CODE]);
  const idLists = extractRetrievalIdLists(span);

  const captionParts = [operation, target].filter(Boolean);
  let caption: string | null = captionParts.length > 0 ? captionParts.join(' ') : null;
  if (system) caption = caption ? `${caption} (${system})` : system;

  const outputLines: string[] = [];
  if (returnedRows !== null) outputLines.push(`returned_rows: ${returnedRows}`);
  if (statusCode) outputLines.push(`status_code: ${statusCode}`);
  for (const list of idLists) {
    outputLines.push(`${list.attribute} (${list.ids.length}):`);
    outputLines.push(...list.ids.map(id => `  - ${id}`));
  }

  return {
    system,
    operation,
    target,
    namespace: namespace && namespace !== target ? namespace : null,
    caption,
    queryText,
    returnedRows,
    statusCode,
    idLists,
    outputText: outputLines.length > 0 ? outputLines.join('\n') : null,
  };
}
