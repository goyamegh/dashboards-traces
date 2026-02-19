/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ReportFormatter,
  ReportFormat,
  ReportFormatterRegistry,
} from '@/services/report/types';

/**
 * Implementation of ReportFormatterRegistry
 * Manages registration and lookup of report formatter implementations
 */
class ReportFormatterRegistryImpl implements ReportFormatterRegistry {
  private formatters: Map<ReportFormat, ReportFormatter> = new Map();

  /**
   * Register a formatter implementation
   */
  register(formatter: ReportFormatter): void {
    if (this.formatters.has(formatter.format)) {
      console.warn(
        `[ReportFormatterRegistry] Overwriting existing formatter for format: ${formatter.format}`
      );
    }
    this.formatters.set(formatter.format, formatter);
  }

  /**
   * Get a formatter by format type
   */
  get(format: ReportFormat): ReportFormatter | undefined {
    return this.formatters.get(format);
  }

  /**
   * Get all registered formatters
   */
  getAll(): ReportFormatter[] {
    return Array.from(this.formatters.values());
  }

  /**
   * Check if a formatter is registered
   */
  has(format: ReportFormat): boolean {
    return this.formatters.has(format);
  }

  /**
   * Get list of supported format strings
   */
  getSupportedFormats(): string[] {
    return Array.from(this.formatters.keys());
  }

  /**
   * Clear all registered formatters (useful for testing)
   */
  clear(): void {
    this.formatters.clear();
  }
}

/**
 * Singleton instance of the report formatter registry
 */
export const reportFormatterRegistry = new ReportFormatterRegistryImpl();

/**
 * Helper function to register a formatter
 */
export function registerFormatter(formatter: ReportFormatter): void {
  reportFormatterRegistry.register(formatter);
}

/**
 * Helper function to get a formatter
 */
export function getFormatter(format: ReportFormat): ReportFormatter | undefined {
  return reportFormatterRegistry.get(format);
}
