/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceStatsView - Summary statistics view for traces
 *
 * Displays summary stats, tools used, and time distribution.
 * This is the left panel from TraceFlowView extracted as a standalone view.
 */

import React, { useMemo } from 'react';
import { Span, TimeRange } from '@/types';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import {
  flattenSpans,
  calculateCategoryStats,
  extractToolStats,
} from '@/services/traces/traceStats';
import {
  SummaryStatsGrid,
  ToolsUsedSection,
  TimeDistributionBar,
} from './TraceSummary';

interface TraceStatsViewProps {
  spanTree: Span[];
  timeRange: TimeRange;
}

export const TraceStatsView: React.FC<TraceStatsViewProps> = ({
  spanTree,
  timeRange,
}) => {
  // Categorize spans
  const categorizedTree = useMemo(
    () => categorizeSpanTree(spanTree),
    [spanTree]
  );

  // Flatten all spans for analysis
  const allSpans = useMemo(
    () => flattenSpans(categorizedTree),
    [categorizedTree]
  );

  // Calculate statistics
  const categoryStats = useMemo(
    () => calculateCategoryStats(allSpans, timeRange.duration),
    [allSpans, timeRange.duration]
  );

  // Extract tool information
  const toolStats = useMemo(
    () => extractToolStats(allSpans),
    [allSpans]
  );

  if (spanTree.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No trace data available
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-4">
        <SummaryStatsGrid categoryStats={categoryStats} toolStats={toolStats} />
        <ToolsUsedSection toolStats={toolStats} />
        <TimeDistributionBar stats={categoryStats} totalDuration={timeRange.duration} />
      </div>
    </div>
  );
};

export default TraceStatsView;
