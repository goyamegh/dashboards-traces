/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, FormatterOutput, FormatterOptions } from '@/services/report/types';
import { BaseFormatter } from '@/services/report/base/BaseFormatter';
import { generateHtmlReport } from './htmlTemplate';

/**
 * HTML Report Formatter
 * Generates a self-contained HTML file with embedded CSS
 */
export class HtmlFormatter extends BaseFormatter {
  readonly format = 'html' as const;
  readonly name = 'HTML Report';
  readonly extension = 'html';

  async generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput> {
    // Default maxTrajectorySteps to 50 for HTML reports
    const htmlOptions: FormatterOptions = {
      maxTrajectorySteps: 50,
      ...options,
    };

    const content = generateHtmlReport(data, htmlOptions);

    return {
      content,
      mimeType: 'text/html',
      filename: this.generateFilename(data.benchmark.name),
    };
  }
}

/** Singleton instance */
export const htmlFormatter = new HtmlFormatter();
