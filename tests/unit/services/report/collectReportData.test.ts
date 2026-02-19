/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectReportData } from '@/services/report/collectReportData';
import {
  calculateRunAggregates,
  buildTestCaseComparisonRows,
  getRealTestCaseMeta,
} from '@/services/comparisonService';

jest.mock('@/services/comparisonService', () => ({
  calculateRunAggregates: jest.fn(),
  buildTestCaseComparisonRows: jest.fn(),
  getRealTestCaseMeta: jest.fn(),
}));

const mockCalcAggregates = calculateRunAggregates as jest.Mock;
const mockBuildRows = buildTestCaseComparisonRows as jest.Mock;
const mockGetRealTestCaseMeta = getRealTestCaseMeta as jest.Mock;

describe('collectReportData', () => {
  const mockBenchmark = {
    id: 'bench-1',
    name: 'Test Benchmark',
    description: 'Test description',
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [],
  };

  const mockRun = {
    id: 'run-1',
    name: 'Run 1',
    createdAt: '2024-01-01T00:00:00Z',
    agentKey: 'mock',
    modelId: 'claude-sonnet',
    results: { 'tc-1': { reportId: 'report-1', status: 'completed' } },
  };

  const mockReport = {
    id: 'report-1',
    testCaseId: 'tc-1',
    timestamp: '2024-01-01T00:00:00Z',
    agentName: 'Mock',
    modelName: 'Sonnet',
    status: 'completed',
    passFailStatus: 'passed',
    trajectory: [],
    metrics: { accuracy: 85 },
    llmJudgeReasoning: 'Good',
  };

  const mockAggregates = {
    runId: 'run-1',
    runName: 'Run 1',
    createdAt: '2024-01-01T00:00:00Z',
    modelId: 'claude-sonnet',
    agentKey: 'mock',
    totalTestCases: 2,
    passedCount: 1,
    failedCount: 1,
    avgAccuracy: 85,
    passRatePercent: 50,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCalcAggregates.mockReturnValue(mockAggregates);
    mockBuildRows.mockReturnValue([]);
  });

  it('should return correct structure with all fields', () => {
    // Arrange
    const reports = { 'report-1': mockReport } as any;

    // Act
    const result = collectReportData(mockBenchmark as any, [mockRun as any], reports);

    // Assert
    expect(result).toEqual(
      expect.objectContaining({
        benchmark: {
          id: 'bench-1',
          name: 'Test Benchmark',
          description: 'Test description',
          testCaseCount: 2,
        },
        runs: [
          expect.objectContaining({
            id: 'run-1',
            name: 'Run 1',
            agentKey: 'mock',
            modelId: 'claude-sonnet',
            aggregates: mockAggregates,
          }),
        ],
        comparisonRows: [],
        reports,
        generatedBy: 'api',
      })
    );
    expect(result.generatedAt).toBeDefined();
  });

  it('should call calculateRunAggregates for each run', () => {
    // Arrange
    const secondRun = {
      id: 'run-2',
      name: 'Run 2',
      createdAt: '2024-01-02T00:00:00Z',
      agentKey: 'mock',
      modelId: 'claude-sonnet',
      results: { 'tc-2': { reportId: 'report-2', status: 'completed' } },
    };
    const reports = { 'report-1': mockReport } as any;

    // Act
    collectReportData(mockBenchmark as any, [mockRun as any, secondRun as any], reports);

    // Assert
    expect(mockCalcAggregates).toHaveBeenCalledTimes(2);
    expect(mockCalcAggregates).toHaveBeenCalledWith(mockRun, reports);
    expect(mockCalcAggregates).toHaveBeenCalledWith(secondRun, reports);
  });

  it('should call buildTestCaseComparisonRows with correct args', () => {
    // Arrange
    const reports = { 'report-1': mockReport } as any;
    const selectedRuns = [mockRun as any];

    // Act
    collectReportData(mockBenchmark as any, selectedRuns, reports);

    // Assert
    expect(mockBuildRows).toHaveBeenCalledTimes(1);
    expect(mockBuildRows).toHaveBeenCalledWith(
      selectedRuns,
      reports,
      expect.any(Function)
    );
  });

  it('should set generatedBy from source parameter', () => {
    // Arrange
    const reports = { 'report-1': mockReport } as any;

    // Act
    const result = collectReportData(
      mockBenchmark as any,
      [mockRun as any],
      reports,
      undefined,
      'cli'
    );

    // Assert
    expect(result.generatedBy).toBe('cli');
  });

  it('should work with empty runs', () => {
    // Arrange
    const reports = {} as any;

    // Act
    const result = collectReportData(mockBenchmark as any, [], reports);

    // Assert
    expect(result.runs).toEqual([]);
    expect(mockCalcAggregates).not.toHaveBeenCalled();
    expect(mockBuildRows).toHaveBeenCalledWith([], reports, expect.any(Function));
  });

  it('should use testCaseMap parameter when provided', () => {
    // Arrange
    const reports = { 'report-1': mockReport } as any;
    const testCaseMap = new Map<string, any>([
      [
        'tc-1',
        {
          id: 'tc-1',
          name: 'Test Case 1',
          category: 'RCA',
          difficulty: 'Medium',
          currentVersion: 3,
          labels: ['category:RCA'],
        },
      ],
    ]);

    // Act
    collectReportData(mockBenchmark as any, [mockRun as any], reports, testCaseMap);

    // Assert
    expect(mockBuildRows).toHaveBeenCalledTimes(1);

    // Extract the getTestCaseMeta function passed to buildTestCaseComparisonRows
    const getTestCaseMeta = mockBuildRows.mock.calls[0][2];

    // Verify it resolves from the map for known IDs
    const meta = getTestCaseMeta('tc-1');
    expect(meta).toEqual({
      id: 'tc-1',
      name: 'Test Case 1',
      category: 'RCA',
      difficulty: 'Medium',
      version: 'v3',
      labels: ['category:RCA'],
    });

    // Verify it falls back to getRealTestCaseMeta for unknown IDs
    getTestCaseMeta('tc-unknown');
    expect(mockGetRealTestCaseMeta).toHaveBeenCalledWith('tc-unknown');
  });
});
