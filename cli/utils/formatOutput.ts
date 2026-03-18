/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Output formatting utilities for CLI commands.
 * Supports table (default), json, and markdown formats.
 */

export type OutputFormat = 'table' | 'json' | 'markdown';

export const OUTPUT_FORMAT_CHOICES = ['table', 'json', 'markdown'] as const;
export const OUTPUT_FORMAT_DESCRIPTION = 'Output format: table, json, markdown';

/**
 * Render data as a markdown table.
 * @param headers - Column header labels
 * @param rows - 2D array of cell values (strings)
 * @returns Formatted markdown table string
 */
export function formatMarkdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => '---');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Format data as JSON string.
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Validate and normalize the output format option.
 */
export function parseOutputFormat(format: string): OutputFormat {
  const normalized = format.toLowerCase();
  if (normalized === 'table' || normalized === 'json' || normalized === 'markdown' || normalized === 'md') {
    return normalized === 'md' ? 'markdown' : normalized as OutputFormat;
  }
  return 'table';
}
