/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Benchmark,
  BenchmarkRun,
  EvaluationReport,
  RunAggregateMetrics,
  TestCaseComparisonRow,
  TrajectoryStep,
} from '@/types';

// ============ Report Format Types ============

/**
 * Supported report formats
 * Extensible via the registry - custom formatters can register additional formats
 */
export type ReportFormat = 'json' | 'html' | 'pdf' | string;

// ============ Report Data Types ============

/**
 * Data for a single run within a report
 */
export interface ReportRunData {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  agentKey: string;
  modelId: string;
  status?: string;
  aggregates: RunAggregateMetrics;
}

/**
 * Complete data package for report generation
 * Assembled by collectReportData() - formatters receive this and only do transformation
 */
export interface ReportData {
  benchmark: {
    id: string;
    name: string;
    description?: string;
    testCaseCount: number;
  };
  runs: ReportRunData[];
  comparisonRows: TestCaseComparisonRow[];
  reports: Record<string, EvaluationReport>;
  generatedAt: string;
  generatedBy: string;
}

// ============ Formatter Types ============

/**
 * Output from a formatter
 */
export interface FormatterOutput {
  content: string | Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Options for report generation
 */
export interface FormatterOptions {
  /** Include full trajectory steps in the report (default: true) */
  includeTrajectories?: boolean;
  /** Maximum trajectory steps to include per test case (default: 50 for HTML) */
  maxTrajectorySteps?: number;
  /** Custom title for the report */
  title?: string;
}

/**
 * Report formatter interface - all formatters must implement this
 */
export interface ReportFormatter {
  /** Unique identifier for this format */
  readonly format: ReportFormat;
  /** Human-readable name */
  readonly name: string;
  /** File extension (without dot) */
  readonly extension: string;
  /** Generate a report from the data */
  generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput>;
}

// ============ Registry Types ============

/**
 * Registry for report formatter implementations
 */
export interface ReportFormatterRegistry {
  /** Register a formatter implementation */
  register(formatter: ReportFormatter): void;
  /** Get a formatter by format type */
  get(format: ReportFormat): ReportFormatter | undefined;
  /** Get all registered formatters */
  getAll(): ReportFormatter[];
  /** Check if a formatter is registered */
  has(format: ReportFormat): boolean;
  /** Get list of supported format strings */
  getSupportedFormats(): string[];
  /** Clear all registered formatters (useful for testing) */
  clear(): void;
}
