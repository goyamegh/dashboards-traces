/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { RunAggregateMetrics } from '@/types';
import { cn, formatDate } from '@/lib/utils';
import { formatDelta, getDeltaColorClass } from '@/services/comparisonService';
import { formatTokens, formatCost, formatDuration } from '@/services/metrics';
import { DEFAULT_CONFIG } from '@/lib/constants';

// Helper to get agent display name from key
const getAgentName = (agentKey: string): string => {
  const agent = DEFAULT_CONFIG.agents.find(a => a.key === agentKey);
  return agent?.name || agentKey;
};

/**
 * Get color class for pass rate value
 */
export function getPassRateColorClass(passRate: number): string {
  if (passRate >= 80) return 'text-opensearch-blue';
  if (passRate >= 50) return 'text-amber-400';
  return 'text-red-400';
}

interface SummaryRow {
  label: string;
  key: string;
  isTraceMetric: boolean;
  higherIsBetter?: boolean;
  getValue: (run: RunAggregateMetrics) => string;
  getNumericValue?: (run: RunAggregateMetrics) => number | undefined;
  showDelta?: boolean;
}

const SUMMARY_ROWS: SummaryRow[] = [
  {
    label: 'Agent',
    key: 'agent',
    isTraceMetric: false,
    getValue: (r) => getAgentName(r.agentKey),
  },
  {
    label: 'Model',
    key: 'model',
    isTraceMetric: false,
    getValue: (r) => r.modelId,
  },
  {
    label: 'Date',
    key: 'date',
    isTraceMetric: false,
    getValue: (r) => formatDate(r.createdAt, 'date'),
  },
  {
    label: 'Pass Rate',
    key: 'passRate',
    isTraceMetric: false,
    higherIsBetter: true,
    showDelta: true,
    getValue: (r) => {
      const passRate = r.totalTestCases > 0
        ? Math.round((r.passedCount / r.totalTestCases) * 100)
        : 0;
      return `${passRate}%`;
    },
    getNumericValue: (r) => r.passRatePercent,
  },
  {
    label: 'Avg Accuracy',
    key: 'accuracy',
    isTraceMetric: false,
    higherIsBetter: true,
    showDelta: true,
    getValue: (r) => `${r.avgAccuracy}%`,
    getNumericValue: (r) => r.avgAccuracy,
  },
  {
    label: 'Tokens',
    key: 'tokens',
    isTraceMetric: true,
    getValue: (r) => r.totalTokens !== undefined ? formatTokens(r.totalTokens) : '-',
    getNumericValue: (r) => r.totalTokens,
  },
  {
    label: 'Cost',
    key: 'cost',
    isTraceMetric: true,
    higherIsBetter: false,
    getValue: (r) => r.totalCostUsd !== undefined ? formatCost(r.totalCostUsd) : '-',
    getNumericValue: (r) => r.totalCostUsd,
  },
  {
    label: 'Avg Duration',
    key: 'duration',
    isTraceMetric: true,
    higherIsBetter: false,
    getValue: (r) => r.avgDurationMs !== undefined ? formatDuration(r.avgDurationMs) : '-',
    getNumericValue: (r) => r.avgDurationMs,
  },
];

/**
 * Get visible metric rows based on whether any run has trace data
 */
export function getVisibleMetricRows(runs: RunAggregateMetrics[]): SummaryRow[] {
  const hasTraceMetrics = runs.some(r => r.totalTokens !== undefined);
  if (hasTraceMetrics) return SUMMARY_ROWS;
  return SUMMARY_ROWS.filter(row => !row.isTraceMetric);
}

interface RunSummaryTableProps {
  runs: RunAggregateMetrics[];
  baselineRunId?: string;
}

export const RunSummaryTable: React.FC<RunSummaryTableProps> = ({
  runs,
  baselineRunId,
}) => {
  if (runs.length === 0) return null;

  const visibleRows = getVisibleMetricRows(runs);
  const effectiveBaselineId = baselineRunId || runs[0]?.runId;

  // Find best run for a metric row (only for rows with higherIsBetter defined)
  const findBestRunId = (row: SummaryRow): string | undefined => {
    if (row.higherIsBetter === undefined || !row.getNumericValue) return undefined;
    let bestRunId: string | undefined;
    let bestValue: number | undefined;

    for (const run of runs) {
      const value = row.getNumericValue(run);
      if (value === undefined) continue;
      if (bestValue === undefined ||
        (row.higherIsBetter ? value > bestValue : value < bestValue)) {
        bestValue = value;
        bestRunId = run.runId;
      }
    }
    return bestRunId;
  };

  return (
    <ScrollArea className="rounded-md border border-border">
      <div className="min-w-max">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36 sticky left-0 bg-background z-10">
                Metric
              </TableHead>
              {runs.map((run) => {
                const isBaseline = run.runId === effectiveBaselineId;
                return (
                  <TableHead
                    key={run.runId}
                    className={cn(
                      'text-center min-w-36',
                      isBaseline && 'bg-blue-500/5'
                    )}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <span className="truncate">{run.runName}</span>
                      {isBaseline && (
                        <Badge
                          variant="outline"
                          className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-xs"
                        >
                          Baseline
                        </Badge>
                      )}
                    </div>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((row) => {
              const bestRunId = findBestRunId(row);
              const baselineRun = runs.find(r => r.runId === effectiveBaselineId);

              return (
                <TableRow key={row.key}>
                  <TableCell className="font-medium sticky left-0 bg-background z-10">
                    {row.label}
                  </TableCell>
                  {runs.map((run) => {
                    const isBaseline = run.runId === effectiveBaselineId;
                    const isBest = bestRunId === run.runId && runs.length > 1;
                    const displayValue = row.getValue(run);

                    // Calculate delta for percentage metrics
                    let deltaElement: React.ReactNode = null;
                    if (row.showDelta && !isBaseline && baselineRun && row.getNumericValue) {
                      const currentVal = row.getNumericValue(run);
                      const baselineVal = row.getNumericValue(baselineRun);
                      if (currentVal !== undefined && baselineVal !== undefined) {
                        const delta = currentVal - baselineVal;
                        if (delta !== 0) {
                          deltaElement = (
                            <span className={cn('text-xs ml-1', getDeltaColorClass(delta))}>
                              {formatDelta(delta)}
                            </span>
                          );
                        }
                      }
                    }

                    // Pass rate gets color-coded
                    const isPassRate = row.key === 'passRate';
                    const passRateClass = isPassRate
                      ? getPassRateColorClass(run.passRatePercent)
                      : undefined;

                    // Pass rate shows counts inline
                    let countsElement: React.ReactNode = null;
                    if (isPassRate) {
                      countsElement = (
                        <span className="text-xs text-muted-foreground ml-1">
                          (<span className="text-opensearch-blue">{run.passedCount}</span>
                          <span className="text-red-400 ml-0.5">{run.failedCount}</span>
                          /{run.totalTestCases})
                        </span>
                      );
                    }

                    return (
                      <TableCell
                        key={run.runId}
                        className={cn(
                          'text-center',
                          isBaseline && 'bg-blue-500/5',
                          isBest && 'bg-opensearch-blue/5'
                        )}
                      >
                        <div className="flex items-center justify-center flex-wrap">
                          <span className={cn(
                            'font-medium',
                            passRateClass,
                            isBest && !isPassRate && 'text-opensearch-blue'
                          )}>
                            {displayValue}
                          </span>
                          {countsElement}
                          {deltaElement}
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};
