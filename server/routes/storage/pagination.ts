/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared pagination-parsing helper for storage list endpoints.
 *
 * Convention (applies to every `GET /api/storage/*` list endpoint that
 * supports pagination): CLAMP, don't 400.
 *
 *   - Page-size param accepts either `size` or `limit` (some callers/tools
 *     use one name, some the other).
 *   - Offset param accepts either `from` or `offset`.
 *   - Missing, non-numeric, negative, or zero size => clamp to the route's
 *     `defaultSize`. A malformed/garbage value degrades to "give me a
 *     reasonable default page" — never to "give me everything" (that
 *     silent fallthrough was the actual bug: `parseInt('abc')` is `NaN`,
 *     and `NaN` is falsy, so `size ? parseInt(size) : <default>` patterns
 *     silently produced `NaN` instead of the intended default, which
 *     several adapters then treated as "no limit").
 *   - Size above `maxSize` => clamp to `maxSize` (hard cap; this is what
 *     actually bounds response size — a caller can't request "everything"
 *     via a huge explicit size either).
 *   - Missing, non-numeric, or negative offset => clamp to 0.
 *
 * We clamp rather than 400 so that malformed/absent params degrade
 * gracefully for existing callers (many of which never send these params
 * at all and expect the route's normal default), while still guaranteeing
 * every response is bounded by `maxSize`.
 */

export interface PaginationLimits {
  /** Page size used when the caller doesn't specify one (or specifies an invalid one). */
  defaultSize: number;
  /** Hard cap — a caller can never get a page larger than this, even if they ask for more. */
  maxSize: number;
}

export interface ParsedPagination {
  size: number;
  from: number;
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse and validate `size`/`limit` + `from`/`offset` query params for a
 * storage list endpoint. See module doc-comment for the clamp convention.
 */
export function parseListPagination(
  query: Record<string, unknown>,
  { defaultSize, maxSize }: PaginationLimits,
): ParsedPagination {
  const rawSize = query.size ?? query.limit;
  const rawFrom = query.from ?? query.offset;

  const parsedSize = toFiniteNumber(rawSize);
  let size = parsedSize !== null && parsedSize > 0 ? Math.floor(parsedSize) : defaultSize;
  if (size > maxSize) size = maxSize;

  const parsedFrom = toFiniteNumber(rawFrom);
  const from = parsedFrom !== null && parsedFrom >= 0 ? Math.floor(parsedFrom) : 0;

  return { size, from };
}

/**
 * Same as {@link parseListPagination}, but preserves "no size param at all
 * means unpaginated / return everything" for routes that have callers
 * intentionally relying on that mode (e.g. `GET /api/storage/test-cases`
 * is used unpaginated by many internal list views and server-side jobs
 * that need the full set). Returns `null` size in that case; a size or
 * limit param being PRESENT (even if invalid) opts into pagination with
 * the normal clamp behavior — an invalid pagination request must never
 * silently degrade into "return everything".
 */
export function parseOptionalListPagination(
  query: Record<string, unknown>,
  limits: PaginationLimits,
): ParsedPagination & { paginated: boolean } {
  const hasSizeParam = query.size !== undefined || query.limit !== undefined;
  if (!hasSizeParam) {
    const parsedFrom = toFiniteNumber(query.from ?? query.offset);
    const from = parsedFrom !== null && parsedFrom >= 0 ? Math.floor(parsedFrom) : 0;
    return { size: Number.POSITIVE_INFINITY, from, paginated: false };
  }
  return { ...parseListPagination(query, limits), paginated: true };
}
