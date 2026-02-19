/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Report Formatter System
 * Provides a pluggable abstraction for generating benchmark reports in different formats
 */

// ============ Type Exports ============
export type {
  ReportFormat,
  ReportData,
  ReportRunData,
  FormatterOutput,
  FormatterOptions,
  ReportFormatter,
  ReportFormatterRegistry,
} from './types';

// ============ Registry Exports ============
export {
  reportFormatterRegistry,
  registerFormatter,
  getFormatter,
} from './registry';

// ============ Base Class Export ============
export { BaseFormatter } from './base/BaseFormatter';

// ============ Data Collection ============
export { collectReportData } from './collectReportData';

// ============ Browser-safe Formatter Exports ============
export { JsonFormatter, jsonFormatter } from './json/JsonFormatter';
export { HtmlFormatter, htmlFormatter } from './html/HtmlFormatter';

// ============ Auto-register Browser-safe Formatters ============
import { reportFormatterRegistry } from './registry';
import { jsonFormatter } from './json/JsonFormatter';
import { htmlFormatter } from './html/HtmlFormatter';

reportFormatterRegistry.register(jsonFormatter);
reportFormatterRegistry.register(htmlFormatter);
