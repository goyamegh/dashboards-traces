/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `response-results` — ranked prediction read from the agent's FINAL ANSWER.
 *
 * Retrieval agents increasingly RETURN a ranked list as their answer — a
 * payload whose body is an ordered `results[]` of `{ id, rank?, score?,
 * title?, … }`, often with an empty answer text. Scoring should credit what
 * the agent RECOMMENDED, not everything it happened to retrieve along the
 * way (that is what `tool-hits-ordered` does, and it over-credits: a gold id
 * fetched by some exploratory tool call but never recommended still counts).
 *
 * Where the list is read from, in order — the first source that yields a
 * list wins and is recorded as `parsedFrom`:
 *   1. `json`      — the final response step's `content` IS a JSON object or
 *                    array.
 *   2. `fenced`    — a ```json … ``` (or bare ```) block inside the response
 *                    text whose body is a JSON object / array.
 *   3. `raw-event` — a non-streaming connector's single raw response payload
 *                    (`report.rawEvents` holding exactly ONE plain object,
 *                    e.g. the REST connector's `rawEvents: [data]`). The
 *                    trajectory's response step is then a RENDERING of that
 *                    payload; the structured payload is more reliable than
 *                    re-parsing the rendering. Streaming connectors store
 *                    many raw events and are never consulted.
 *   4. `text`      — best-effort: list lines (`1.` / `-` / `*` / `•`) carrying
 *                    an explicit `id` label, e.g. `1. id 2079 — title` or
 *                    `- Some title (id: 123)`. The label is REQUIRED — bare
 *                    numbers in prose are never taken as ids.
 *   5. `none`      — a response step exists but no list could be found →
 *                    EMPTY prediction (a retrieval agent that returned
 *                    nothing is a real, scorable outcome).
 *
 * "Final response step" = the last `response` step of the trajectory, or the
 * last `assistant` step when there is no `response` step at all. No such step
 * AND no raw payload ⇒ `present: false` ⇒ the engine treats every metric as
 * UNEVALUABLE (we cannot tell an abstaining agent from a crashed one).
 *
 * Inside a parsed JSON value the list is found at `path` (dotted) when the
 * evaluator declares one, else auto-detected: the root array itself, then
 * the conventional keys `results` / `hits` / `items`, then the first array
 * (root keys in order, one level deep) whose elements are objects carrying
 * `idField`. Items are ordered by `rankField` (ascending, when the field is
 * numeric on every item) else by array order; ids are deduped keeping the
 * first occurrence and capped at {@link MAX_CANDIDATES}.
 */

import type { DeterministicEvaluatorInputs, EvaluationReport, TrajectoryStep } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';
import { getPath, MAX_CANDIDATES } from '@/lib/scoring/prediction/toolHitsOrdered';

export const RESPONSE_RESULTS_RULE = 'response-results' as const;
export const DEFAULT_RESPONSE_ID_FIELD = 'id';
export const DEFAULT_RESPONSE_RANK_FIELD = 'rank';
/** Keys tried (in order) when `path` is not declared and the root is an object. */
export const DEFAULT_RESPONSE_LIST_KEYS: ReadonlyArray<string> = ['results', 'hits', 'items'];

export type ResponseResultsParsedFrom = 'json' | 'fenced' | 'raw-event' | 'text' | 'none';

export interface ResponseResultsOptions {
  /** Dotted path to the array inside the parsed JSON (default: auto-detect). */
  path?: string;
  /** Key carrying an item's id (default `id`). */
  idField?: string;
  /** Key carrying an item's 1-based rank (default `rank`); array order when absent/non-numeric. */
  rankField?: string;
}

export interface ResponseResultsPrediction {
  rule: typeof RESPONSE_RESULTS_RULE;
  /** Ranked recommended ids, deduped, capped. Empty = the agent returned nothing. */
  ranked: string[];
  /** Ids found before dedupe / cap. */
  candidateCount: number;
  /** Which source produced the list (`none` = a response existed but carried no list). */
  parsedFrom: ResponseResultsParsedFrom;
  /** A final response step (or a single raw payload) existed — false ⇒ unevaluable. */
  present: boolean;
  /** Whether a `response` / `assistant` step was found in the trajectory. */
  hasAnswer: boolean;
}

interface ListItem {
  id: string;
  rank: number | undefined;
}

const idOf = (item: unknown, idField: string): string | null => {
  if (!item || typeof item !== 'object') return null;
  const v = (item as Record<string, unknown>)[idField];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

const rankOf = (item: unknown, rankField: string): number | undefined => {
  if (!item || typeof item !== 'object') return undefined;
  const v = (item as Record<string, unknown>)[rankField];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** An array whose elements are objects carrying `idField` (at least one). */
const looksLikeResultList = (value: unknown, idField: string): value is unknown[] =>
  Array.isArray(value) && value.length > 0 && value.every(v => v && typeof v === 'object' && !Array.isArray(v)) && value.some(v => idOf(v, idField) !== null);

/**
 * Locate the results array in a parsed JSON value. Returns the array (possibly
 * empty) or `undefined` when no list could be found.
 */
export function findResultsArray(root: unknown, opts: Required<Pick<ResponseResultsOptions, 'idField'>> & Pick<ResponseResultsOptions, 'path'>): unknown[] | undefined {
  if (opts.path) {
    const v = getPath(root, opts.path);
    return Array.isArray(v) ? v : undefined;
  }
  if (Array.isArray(root)) {
    // A root array is the list itself when empty or when its items are id-carrying objects.
    return root.length === 0 || looksLikeResultList(root, opts.idField) ? root : undefined;
  }
  if (!root || typeof root !== 'object') return undefined;
  const obj = root as Record<string, unknown>;
  for (const key of DEFAULT_RESPONSE_LIST_KEYS) {
    const v = obj[key];
    if (Array.isArray(v) && (v.length === 0 || looksLikeResultList(v, opts.idField))) return v;
  }
  for (const key of Object.keys(obj)) {
    if (looksLikeResultList(obj[key], opts.idField)) return obj[key] as unknown[];
  }
  // One level deep (e.g. `{ data: { results: [...] } }`).
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
    const nested = findResultsArray(child, { idField: opts.idField });
    if (nested) return nested;
  }
  return undefined;
}

/** Ordered ids of a results array: by `rankField` when numeric on every item, else array order. */
export function idsFromResultsArray(items: unknown[], opts: Required<Pick<ResponseResultsOptions, 'idField' | 'rankField'>>): string[] {
  const listed: ListItem[] = [];
  for (const item of items) {
    const id = idOf(item, opts.idField);
    if (id === null) continue;
    listed.push({ id, rank: rankOf(item, opts.rankField) });
  }
  const allRanked = listed.length > 0 && listed.every(i => i.rank !== undefined);
  if (allRanked) {
    // Stable: equal ranks keep array order.
    listed.sort((a, b) => (a.rank as number) - (b.rank as number));
  }
  return listed.map(i => i.id);
}

const tryParseJson = (text: string): unknown => {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

// Any language tag: a non-JSON block (```js …```) must still consume its own
// closing fence so the following ```json block aligns.
const FENCE_RE = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Every parseable JSON object/array inside fenced code blocks, in order. */
export function fencedJsonBlocks(text: string): unknown[] {
  const out: unknown[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const parsed = tryParseJson(m[1]);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * Best-effort text fallback: list lines with an explicit `id` label.
 *   `1. id 2079 — Some title (score 6.3)`   → 2079
 *   `- Some title (id: 123)`                → 123
 *   `* ID #A-77`                            → A-77
 * A line must start like a list item (`1.` `1)` `-` `*` `•`) AND carry the
 * whole word `id` (case-insensitive) followed by an optional `:`/`=`/`#` and
 * the id token. Lines without the label are ignored, so prose numbers, scores
 * and prices are never mistaken for ids.
 */
const LIST_LINE_RE = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/;
const ID_LABEL_RE = /\bid\b[`"']?\s*[:=#]?\s*[`"'(]?([A-Za-z0-9][A-Za-z0-9_.:-]*)/i;

export function idsFromTextList(text: string): string[] {
  const ids: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = LIST_LINE_RE.exec(rawLine);
    if (!line) continue;
    const m = ID_LABEL_RE.exec(line[1]);
    if (!m) continue;
    // Trim a trailing sentence period (`id 42.`) but keep dotted ids (`doc.42`).
    ids.push(m[1].replace(/\.$/, ''));
  }
  return ids;
}

/** The final response step: the last `response`, else the last `assistant` step with string content. */
export function finalResponseStep(trajectory: ReadonlyArray<TrajectoryStep> | null | undefined): TrajectoryStep | undefined {
  const steps = Array.isArray(trajectory) ? trajectory : [];
  let lastAssistant: TrajectoryStep | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s || typeof s.content !== 'string') continue;
    if (s.type === 'response') return s;
    if (s.type === 'assistant' && !lastAssistant) lastAssistant = s;
  }
  return lastAssistant;
}

/** The single raw response payload of a non-streaming connector, when that is what `rawEvents` holds. */
const singleRawPayload = (rawEvents: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(rawEvents) || rawEvents.length !== 1) return undefined;
  const only = rawEvents[0];
  return only && typeof only === 'object' && !Array.isArray(only) ? (only as Record<string, unknown>) : undefined;
};

export function extractResponseResults(
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[] },
  options: ResponseResultsOptions = {}
): ResponseResultsPrediction {
  const idField = options.idField?.trim() || DEFAULT_RESPONSE_ID_FIELD;
  const rankField = options.rankField?.trim() || DEFAULT_RESPONSE_RANK_FIELD;
  const path = options.path?.trim() || undefined;
  const step = finalResponseStep(report?.trajectory);
  const rawPayload = singleRawPayload(report?.rawEvents);
  const text = step?.content ?? '';

  const finish = (ids: string[], parsedFrom: ResponseResultsParsedFrom): ResponseResultsPrediction => ({
    rule: RESPONSE_RESULTS_RULE,
    ranked: dedupeIds(ids).slice(0, MAX_CANDIDATES),
    candidateCount: ids.length,
    parsedFrom,
    present: step !== undefined || rawPayload !== undefined,
    hasAnswer: step !== undefined,
  });
  const fromValue = (value: unknown): string[] | undefined => {
    const arr = findResultsArray(value, { idField, path });
    return arr ? idsFromResultsArray(arr, { idField, rankField }) : undefined;
  };

  // 1. The response IS JSON.
  const whole = tryParseJson(text);
  if (whole !== undefined) {
    const ids = fromValue(whole);
    if (ids) return finish(ids, 'json');
  }
  // 2. Fenced JSON inside the text.
  for (const block of fencedJsonBlocks(text)) {
    const ids = fromValue(block);
    if (ids) return finish(ids, 'fenced');
  }
  // 3. Single raw payload of a non-streaming connector.
  if (rawPayload) {
    const ids = fromValue(rawPayload);
    if (ids) return finish(ids, 'raw-event');
  }
  // 4. Rendered text list with explicit id labels.
  const textIds = text ? idsFromTextList(text) : [];
  if (textIds.length > 0) return finish(textIds, 'text');
  // 5. A response existed but carried no list → empty prediction.
  return finish([], 'none');
}

/** Build the extractor options from an evaluator's declared `inputs.prediction`. */
export function responseResultsOptionsFromInputs(prediction: DeterministicEvaluatorInputs['prediction'] | undefined): ResponseResultsOptions {
  if (!prediction || prediction.source !== 'response-results') return {};
  return { path: prediction.path, idField: prediction.idField, rankField: prediction.rankField };
}
