/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import type {
  ReportFormat,
  ReportData,
  ReportFormatter,
  FormatterOutput,
  FormatterOptions,
} from '@/services/report/types';
import { generateExportFilename } from '@/lib/benchmarkExport';

/**
 * Abstract base class for report formatters
 * Provides common functionality for filename generation and trajectory truncation
 */
export abstract class BaseFormatter implements ReportFormatter {
  abstract readonly format: ReportFormat;
  abstract readonly name: string;
  abstract readonly extension: string;

  abstract generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput>;

  /**
   * Generate a filename for the report based on benchmark name
   * Reuses the existing sanitization logic from benchmarkExport
   */
  protected generateFilename(benchmarkName: string): string {
    const base = generateExportFilename(benchmarkName);
    // Replace the default .json extension with the formatter's extension
    return base.replace(/\.json$/, `.${this.extension}`);
  }

  /**
   * Truncate trajectory steps based on options
   */
  protected truncateTrajectory(
    trajectory: TrajectoryStep[],
    options?: FormatterOptions
  ): { steps: TrajectoryStep[]; truncatedCount: number } {
    const maxSteps = options?.maxTrajectorySteps;
    if (!maxSteps || trajectory.length <= maxSteps) {
      return { steps: trajectory, truncatedCount: 0 };
    }
    return {
      steps: trajectory.slice(0, maxSteps),
      truncatedCount: trajectory.length - maxSteps,
    };
  }
}
