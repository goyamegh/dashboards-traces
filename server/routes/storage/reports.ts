/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reports Routes - Generate downloadable reports for benchmark runs
 *
 * GET /api/storage/benchmarks/:id/report
 *   Query params:
 *     format  - 'json' | 'html' | 'pdf' (default: 'json')
 *     runIds  - comma-separated run IDs (default: all runs)
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { SAMPLE_BENCHMARKS } from '../../../cli/demo/sampleBenchmarks.js';
import { SAMPLE_RUNS } from '../../../cli/demo/sampleRuns.js';
import { reportFormatterRegistry, collectReportData } from '../../../services/report/server.js';
import type { Benchmark, BenchmarkRun, EvaluationReport } from '../../../types/index.js';

const router = Router();

/**
 * Normalize benchmark data (same pattern as benchmarks.ts)
 */
function normalizeBenchmark(doc: any): Benchmark {
  const version = doc.currentVersion ?? doc.version ?? 1;
  return {
    ...doc,
    updatedAt: doc.updatedAt ?? doc.createdAt,
    currentVersion: version,
    versions: doc.versions ?? [{
      version: 1,
      createdAt: doc.createdAt,
      testCaseIds: doc.testCaseIds || [],
    }],
    runs: (doc.runs || []).sort((a: BenchmarkRun, b: BenchmarkRun) => {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }),
  };
}

/**
 * Validate report parameters
 * Returns error message if invalid, null if valid
 */
function validateReportParams(format: string): string | null {
  if (!reportFormatterRegistry.has(format)) {
    const supported = reportFormatterRegistry.getSupportedFormats().join(', ');
    return `Unsupported format: '${format}'. Supported formats: ${supported}`;
  }
  return null;
}

/**
 * Fetch a benchmark by ID from sample data or OpenSearch
 */
async function fetchBenchmark(id: string, req: Request): Promise<Benchmark | null> {
  // Check sample data first
  if (id.startsWith('demo-')) {
    const sample = SAMPLE_BENCHMARKS.find((bench) => bench.id === id);
    if (sample) return normalizeBenchmark(sample);
  }

  // Fetch from OpenSearch
  if (isStorageAvailable(req)) {
    try {
      const client = requireStorageClient(req);
      const result = await client.get({ index: INDEXES.benchmarks, id });
      if (result.body.found) {
        return normalizeBenchmark(result.body._source);
      }
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  return null;
}

/**
 * Fetch reports for given report IDs
 */
async function fetchReports(
  reportIds: string[],
  req: Request
): Promise<Record<string, EvaluationReport>> {
  const reports: Record<string, EvaluationReport> = {};
  if (reportIds.length === 0) return reports;

  // Check sample data
  const sampleReports = SAMPLE_RUNS.filter((r) => reportIds.includes(r.id));
  for (const r of sampleReports) {
    reports[r.id] = r as EvaluationReport;
  }

  // Fetch remaining from OpenSearch
  const resolvedIds = new Set(Object.keys(reports));
  const unresolvedIds = reportIds.filter((id) => !resolvedIds.has(id));

  if (unresolvedIds.length > 0 && isStorageAvailable(req)) {
    try {
      const client = requireStorageClient(req);
      const result = await client.search({
        index: INDEXES.runs,
        body: {
          size: unresolvedIds.length,
          query: { terms: { id: unresolvedIds } },
        },
      });

      const hits = result.body.hits?.hits || [];
      for (const hit of hits) {
        const report = hit._source as EvaluationReport;
        reports[report.id] = report;
      }
    } catch (error: any) {
      console.warn('[ReportsAPI] Failed to fetch reports:', error.message);
    }
  }

  return reports;
}

// GET /api/storage/benchmarks/:id/report
router.get('/api/storage/benchmarks/:id/report', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const format = (req.query.format as string) || 'json';
    const runIdsParam = req.query.runIds as string | undefined;

    // Validate format
    const formatError = validateReportParams(format);
    if (formatError) {
      return res.status(400).json({ error: formatError });
    }

    // Fetch benchmark
    const benchmark = await fetchBenchmark(id, req);
    if (!benchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Filter runs by runIds if specified
    let selectedRuns = benchmark.runs || [];
    if (runIdsParam) {
      const requestedIds = runIdsParam.split(',').map((s) => s.trim()).filter(Boolean);
      selectedRuns = selectedRuns.filter((r) => requestedIds.includes(r.id));
      if (selectedRuns.length === 0) {
        return res.status(400).json({ error: 'No matching runs found for the specified runIds' });
      }
    }

    // Collect all report IDs from selected runs
    const reportIds: string[] = [];
    for (const run of selectedRuns) {
      for (const result of Object.values(run.results || {})) {
        if (result.reportId) {
          reportIds.push(result.reportId);
        }
      }
    }

    // Fetch reports
    const reports = await fetchReports(reportIds, req);

    // Assemble report data
    const reportData = collectReportData(benchmark, selectedRuns, reports, undefined, 'api');

    // Generate report
    const formatter = reportFormatterRegistry.get(format)!;
    const output = await formatter.generate(reportData);

    // Set response headers
    res.setHeader('Content-Type', output.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);

    // Send content
    res.send(output.content);
  } catch (error: any) {
    console.error('[ReportsAPI] Report generation failed:', error.message);

    // Return 400 for known dependency issues (e.g., puppeteer not installed)
    if (error.message?.includes('puppeteer')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: error.message });
  }
});

export default router;
