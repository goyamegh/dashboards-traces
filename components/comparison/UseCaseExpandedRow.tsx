/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GitBranch, Scale, Activity } from 'lucide-react';
import { EvaluationReport, BenchmarkRun } from '@/types';
import { TrajectorySection } from './sections/TrajectorySection';
import { TaskSection } from './sections/TaskSection';
import { JudgeSection } from './sections/JudgeSection';
import { TraceFlowComparison } from './sections/TraceFlowComparison';

interface UseCaseExpandedRowProps {
  useCaseId: string;
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  /** Trace-window hints per agent runId so the Traces tab can render spans. */
  windowAgentsByRunId?: Map<string, { serviceName?: string; startedAt: number; endedAt: number }>;
  /** A span citation clicked in the deep-dive (this row) → open Traces + highlight. */
  spanDeepLink?: { runId: string; spanId: string; nonce: number } | null;
}

export const UseCaseExpandedRow: React.FC<UseCaseExpandedRowProps> = ({
  useCaseId,
  runs,
  reports,
  windowAgentsByRunId,
  spanDeepLink,
}) => {
  const [tab, setTab] = useState<string>('trajectory');
  // A span citation deep-link forces the Traces tab open.
  useEffect(() => {
    if (spanDeepLink) setTab('traces');
  }, [spanDeepLink?.nonce]);

  return (
    <div className="p-4 bg-muted/20 border-t border-border">
      <TaskSection testCaseId={useCaseId} />
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="trajectory" className="gap-2">
            <GitBranch size={14} />
            Trajectory
          </TabsTrigger>
          <TabsTrigger value="traces" className="gap-2">
            <Activity size={14} />
            Traces
          </TabsTrigger>
          <TabsTrigger value="judge" className="gap-2">
            <Scale size={14} />
            Judge Evaluation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trajectory" className="mt-0">
          <TrajectorySection
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
          />
        </TabsContent>

        <TabsContent value="traces" className="mt-0">
          <TraceFlowComparison
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
            windowAgentsByRunId={windowAgentsByRunId}
            highlight={spanDeepLink}
          />
        </TabsContent>

        <TabsContent value="judge" className="mt-0">
          <JudgeSection
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};
