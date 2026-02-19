/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-only Report Formatter Exports
 * Includes PDF formatter which requires Node.js (puppeteer)
 *
 * Import this file in CLI/server code to get access to all formatters including PDF
 */

// Re-export everything from the main index (browser-safe formatters)
export * from './index';

// Export server-only formatters
export { PdfFormatter, pdfFormatter } from './pdf/PdfFormatter';

// Register server-only formatters
import { reportFormatterRegistry } from './registry';
import { pdfFormatter } from './pdf/PdfFormatter';

reportFormatterRegistry.register(pdfFormatter);
