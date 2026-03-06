/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mapping Validator Service
 *
 * Inspects actual OpenSearch index mappings and identifies fields whose types
 * are incompatible with the expected types defined in INDEX_MAPPINGS.
 *
 * The most common scenario: OpenSearch auto-creates an index when a document
 * is indexed before explicit mappings are applied, defaulting string fields to
 * `text` instead of `keyword`. All queries in the codebase use `term` queries
 * which silently return 0 results on `text` fields.
 */

import { Client } from '@opensearch-project/opensearch';
import { INDEX_MAPPINGS } from '../constants/indexMappings';
import { debug } from '@/lib/debug';

// ============================================================================
// Types
// ============================================================================

export interface MappingIssue {
  indexName: string;
  field: string;
  expectedType: string;
  actualType: string;
  hasKeywordSubfield: boolean;
  fixable: boolean;
}

export interface ValidationResult {
  indexName: string;
  status: 'ok' | 'needs_reindex';
  issues: MappingIssue[];
  documentCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Recursively extract field types from an OpenSearch mapping properties object.
 * Returns a flat map of dotted field paths to their type info.
 *
 * Example: { id: { type: 'text', fields: { keyword: { type: 'keyword' } } } }
 * → { 'id': { type: 'text', hasKeywordSubfield: true } }
 */
function flattenMappingProperties(
  properties: Record<string, any>,
  prefix = ''
): Map<string, { type: string; hasKeywordSubfield: boolean }> {
  const result = new Map<string, { type: string; hasKeywordSubfield: boolean }>();

  for (const [fieldName, fieldDef] of Object.entries(properties)) {
    const fullPath = prefix ? `${prefix}.${fieldName}` : fieldName;

    if (fieldDef.type) {
      const hasKeywordSubfield = !!(
        fieldDef.fields &&
        typeof fieldDef.fields === 'object' &&
        Object.values(fieldDef.fields).some((sub: any) => sub.type === 'keyword')
      );
      result.set(fullPath, { type: fieldDef.type, hasKeywordSubfield });
    }

    // Recurse into nested properties (e.g., nested objects, metrics.properties)
    if (fieldDef.properties) {
      const nested = flattenMappingProperties(fieldDef.properties, fullPath);
      for (const [k, v] of nested) {
        result.set(k, v);
      }
    }
  }

  return result;
}

/**
 * Extract the expected keyword fields from INDEX_MAPPINGS for a given index.
 * Returns field paths where the expected type is 'keyword'.
 */
function getExpectedKeywordFields(indexName: string): Map<string, string> {
  const mapping = INDEX_MAPPINGS[indexName];
  if (!mapping?.mappings?.properties) return new Map();

  const expected = new Map<string, string>();
  const flat = flattenMappingProperties(mapping.mappings.properties);
  for (const [field, info] of flat) {
    if (info.type === 'keyword') {
      expected.set(field, 'keyword');
    }
  }
  return expected;
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Validate all indexes defined in INDEX_MAPPINGS against the actual cluster mappings.
 * Returns a ValidationResult per index indicating whether it needs reindexing.
 */
export async function validateIndexMappings(client: Client): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const indexName of Object.keys(INDEX_MAPPINGS)) {
    try {
      // Check if index exists
      const exists = await client.indices.exists({ index: indexName });
      if (!exists.body) {
        debug('MappingValidator', `Index ${indexName} does not exist, skipping`);
        continue;
      }

      // Get actual mappings
      const mappingResponse = await client.indices.getMapping({ index: indexName });
      const actualProperties = mappingResponse.body?.[indexName]?.mappings?.properties ?? {};
      const actualFields = flattenMappingProperties(actualProperties);

      // Get expected keyword fields
      const expectedKeywordFields = getExpectedKeywordFields(indexName);

      // Compare
      const issues: MappingIssue[] = [];
      for (const [field, expectedType] of expectedKeywordFields) {
        const actual = actualFields.get(field);
        if (!actual) continue; // Field doesn't exist yet — ensureIndexes will add it

        if (actual.type !== expectedType) {
          issues.push({
            indexName,
            field,
            expectedType,
            actualType: actual.type,
            hasKeywordSubfield: actual.hasKeywordSubfield,
            fixable: true,
          });
        }
      }

      // Get document count
      let documentCount = 0;
      try {
        const countResponse = await client.count({ index: indexName });
        documentCount = countResponse.body.count ?? 0;
      } catch {
        // Ignore count errors — non-critical
      }

      results.push({
        indexName,
        status: issues.length > 0 ? 'needs_reindex' : 'ok',
        issues,
        documentCount,
      });

      if (issues.length > 0) {
        const fieldList = issues.map((i) => i.field).join(', ');
        debug(
          'MappingValidator',
          `Index ${indexName}: ${issues.length} incompatible field(s): ${fieldList}`
        );
      }
    } catch (error: any) {
      // If the index doesn't exist (404), skip silently
      if (error.meta?.statusCode === 404) {
        debug('MappingValidator', `Index ${indexName} not found (404), skipping`);
        continue;
      }
      // For other errors, log and skip this index
      console.error(`[MappingValidator] Error validating ${indexName}:`, error.message);
    }
  }

  return results;
}
