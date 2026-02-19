/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { JsonFormatter } from '@/services/report/json/JsonFormatter';
import type { ReportData } from '@/services/report/types';

const mockReportData: ReportData = {
  benchmark: {
    id: 'bench-1',
    name: 'Test Benchmark',
    description: 'Test description',
    testCaseCount: 2,
  },
  runs: [
    {
      id: 'run-1',
      name: 'Run 1',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'mock',
      modelId: 'claude-sonnet',
      aggregates: {
        runId: 'run-1',
        runName: 'Run 1',
        createdAt: '2024-01-01T00:00:00Z',
        modelId: 'claude-sonnet',
        agentKey: 'mock',
        totalTestCases: 2,
        passedCount: 1,
        failedCount: 1,
        avgAccuracy: 75,
        passRatePercent: 50,
      },
    },
  ],
  comparisonRows: [
    {
      testCaseId: 'tc-1',
      testCaseName: 'Test Case 1',
      labels: ['category:RCA'],
      category: 'RCA' as any,
      difficulty: 'Medium' as any,
      results: {
        'run-1': {
          reportId: 'report-1',
          status: 'completed' as const,
          passFailStatus: 'passed' as any,
          accuracy: 85,
        },
      },
      hasVersionDifference: false,
      versions: ['v1'],
    },
  ],
  reports: {
    'report-1': {
      id: 'report-1',
      testCaseId: 'tc-1',
      timestamp: '2024-01-01T00:00:00Z',
      agentName: 'Mock Agent',
      modelName: 'Sonnet',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [
        { id: 's1', timestamp: 1, type: 'thinking', content: 'Thinking...' },
        { id: 's2', timestamp: 2, type: 'action', content: 'Running tool', toolName: 'search' },
        { id: 's3', timestamp: 3, type: 'tool_result', content: 'Found results', status: 'SUCCESS' },
        { id: 's4', timestamp: 4, type: 'response', content: 'Final answer' },
      ],
      metrics: { accuracy: 85 },
      llmJudgeReasoning: 'Good performance overall',
      improvementStrategies: [
        { category: 'Search', issue: 'Narrow results', recommendation: 'Add filters', priority: 'high' },
      ],
    } as any,
  },
  generatedAt: '2024-01-15T12:00:00Z',
  generatedBy: 'test',
};

describe('JsonFormatter', () => {
  let formatter: JsonFormatter;

  beforeEach(() => {
    jest.clearAllMocks();
    formatter = new JsonFormatter();
  });

  it('should have format property set to json', () => {
    expect(formatter.format).toBe('json');
  });

  it('should have extension property set to json', () => {
    expect(formatter.extension).toBe('json');
  });

  it('should return valid JSON string content from generate()', async () => {
    const output = await formatter.generate(mockReportData);

    expect(typeof output.content).toBe('string');
    expect(() => JSON.parse(output.content as string)).not.toThrow();
  });

  it('should produce content that parses back to match input data', async () => {
    const output = await formatter.generate(mockReportData);
    const parsed = JSON.parse(output.content as string);

    expect(parsed.benchmark).toEqual(mockReportData.benchmark);
    expect(parsed.runs).toEqual(mockReportData.runs);
    expect(parsed.comparisonRows).toEqual(mockReportData.comparisonRows);
    expect(parsed.reports).toEqual(mockReportData.reports);
    expect(parsed.generatedAt).toBe(mockReportData.generatedAt);
    expect(parsed.generatedBy).toBe(mockReportData.generatedBy);
  });

  it('should have mimeType set to application/json', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.mimeType).toBe('application/json');
  });

  it('should produce a filename ending with .json containing sanitized benchmark name', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.filename).toMatch(/\.json$/);
    expect(output.filename).toContain('test-benchmark');
  });

  it('should strip trajectory arrays from reports when includeTrajectories is false', async () => {
    const output = await formatter.generate(mockReportData, { includeTrajectories: false });
    const parsed = JSON.parse(output.content as string);

    // Reports should exist but without trajectory
    expect(parsed.reports['report-1']).toBeDefined();
    expect(parsed.reports['report-1'].trajectory).toBeUndefined();

    // Other report fields should still be present
    expect(parsed.reports['report-1'].id).toBe('report-1');
    expect(parsed.reports['report-1'].passFailStatus).toBe('passed');
    expect(parsed.reports['report-1'].llmJudgeReasoning).toBe('Good performance overall');
  });
});
