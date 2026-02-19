/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, FormatterOutput, FormatterOptions } from '@/services/report/types';
import { BaseFormatter } from '@/services/report/base/BaseFormatter';

/**
 * JSON Report Formatter
 * Serializes ReportData to formatted JSON
 */
export class JsonFormatter extends BaseFormatter {
  readonly format = 'json' as const;
  readonly name = 'JSON Report';
  readonly extension = 'json';

  async generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput> {
    let outputData: any = { ...data };

    // Strip trajectories if not requested
    if (options?.includeTrajectories === false) {
      const strippedReports: Record<string, any> = {};
      for (const [id, report] of Object.entries(data.reports)) {
        const { trajectory, ...rest } = report;
        strippedReports[id] = rest;
      }
      outputData = { ...data, reports: strippedReports };
    }

    const content = JSON.stringify(outputData, null, 2);

    return {
      content,
      mimeType: 'application/json',
      filename: this.generateFilename(data.benchmark.name),
    };
  }
}

/** Singleton instance */
export const jsonFormatter = new JsonFormatter();
