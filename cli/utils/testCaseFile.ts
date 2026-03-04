/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared utilities for loading and validating test case JSON files.
 * Used by both `benchmark` and `import` CLI commands.
 */

import { readFileSync } from 'fs';
import { validateTestCasesArrayJson, type ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';

/**
 * Check if a string looks like a file path (ends with .json)
 */
export function isFilePath(value: string): boolean {
  return value.toLowerCase().endsWith('.json');
}

/**
 * Load and validate test cases from a JSON file
 */
export function loadAndValidateTestCasesFile(filePath: string): ValidatedTestCaseInput[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read file: ${filePath} (${err instanceof Error ? err.message : err})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in file: ${filePath}`);
  }

  const result = validateTestCasesArrayJson(parsed);
  if (!result.valid || !result.data) {
    const msgs = result.errors.map(e => e.path ? `${e.path}: ${e.message}` : e.message).join('\n  ');
    throw new Error(`Validation failed for ${filePath}:\n  ${msgs}`);
  }

  return result.data;
}
