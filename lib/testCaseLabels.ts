/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for the unified `labels` tagging system that replaces the legacy
 * top-level `category` and `difficulty` fields on TestCase.
 *
 * Convention: structured labels use a `prefix:value` form so we can extract
 * specific facets (e.g. category, difficulty) when the UI needs them.
 *
 *   'category:RCA'
 *   'difficulty:Medium'
 *   'team:platform'
 *   'tier:p0'
 *
 * Free-form labels without a prefix are also allowed for human tagging.
 */

const CATEGORY_PREFIX = 'category:';
const DIFFICULTY_PREFIX = 'difficulty:';
const SUBCATEGORY_PREFIX = 'subcategory:';

export type DifficultyLabel = 'Easy' | 'Medium' | 'Hard';

/**
 * Extract the category from a labels array, or undefined when not present.
 * If multiple `category:` labels are present, the first one wins.
 */
export function getCategoryFromLabels(labels?: string[]): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const hit = labels.find(l => l.startsWith(CATEGORY_PREFIX));
  return hit ? hit.slice(CATEGORY_PREFIX.length) || undefined : undefined;
}

/**
 * Extract the difficulty from a labels array, or undefined when not present.
 * Values are normalized to the canonical `Easy | Medium | Hard` form when
 * possible; non-canonical values are returned as-is.
 */
export function getDifficultyFromLabels(labels?: string[]): DifficultyLabel | string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const hit = labels.find(l => l.startsWith(DIFFICULTY_PREFIX));
  if (!hit) return undefined;
  const raw = hit.slice(DIFFICULTY_PREFIX.length).trim();
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (normalized === 'Easy' || normalized === 'Medium' || normalized === 'Hard') {
    return normalized;
  }
  return raw || undefined;
}

/**
 * Extract the subcategory from a labels array, or undefined when not present.
 */
export function getSubcategoryFromLabels(labels?: string[]): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const hit = labels.find(l => l.startsWith(SUBCATEGORY_PREFIX));
  return hit ? hit.slice(SUBCATEGORY_PREFIX.length) || undefined : undefined;
}

/**
 * Build a labels array from the legacy top-level `category` / `difficulty`
 * fields, preserving any existing labels and refusing to add a duplicate
 * facet (e.g. won't add `category:RCA` if a `category:` label is already
 * present).
 */
export function migrateLegacyFieldsToLabels(input: {
  category?: string;
  difficulty?: string;
  subcategory?: string;
  labels?: string[];
}): string[] {
  const out = [...(input.labels ?? [])];
  if (input.category && !out.some(l => l.startsWith(CATEGORY_PREFIX))) {
    out.push(`${CATEGORY_PREFIX}${input.category}`);
  }
  if (input.difficulty && !out.some(l => l.startsWith(DIFFICULTY_PREFIX))) {
    out.push(`${DIFFICULTY_PREFIX}${input.difficulty}`);
  }
  if (input.subcategory && !out.some(l => l.startsWith(SUBCATEGORY_PREFIX))) {
    out.push(`${SUBCATEGORY_PREFIX}${input.subcategory}`);
  }
  return out;
}

/**
 * Returns true when the labels array contains a structured facet for the
 * given prefix. Useful in migrations to avoid double-applying.
 */
export function hasLabelPrefix(labels: string[] | undefined, prefix: string): boolean {
  if (!labels) return false;
  const normalized = prefix.endsWith(':') ? prefix : `${prefix}:`;
  return labels.some(l => l.startsWith(normalized));
}
