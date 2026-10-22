/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentFailureCard — the "what actually went wrong" card at the top of the
 * run-detail Test Case Output tab for a report whose AGENT request failed
 * (`failureStage: 'agent'`): the unwrapped cause, the endpoint, how long we
 * waited, the HTTP status when there was one, and the remedy (re-run; there
 * is nothing to judge). Pre-fix this tab was simply empty for these cases.
 */

import React from 'react';
import { PlugZap } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { EvaluationReport } from '@/types';
import { agentProducedNoOutput, describeAgentErrorKind, formatMs } from '@/lib/reportFailure';

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <span className={`break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export const AgentFailureCard: React.FC<{ report: EvaluationReport; className?: string }> = ({ report, className }) => {
  if (report.failureStage !== 'agent') return null;
  const ae = report.agentError;
  const cause = ae?.message ?? report.error ?? report.traceError;
  return (
    <Card
      className={`bg-orange-50 dark:bg-orange-500/10 border-orange-300 dark:border-orange-500/40 ${className ?? ''}`}
      data-testid="run-failure-card"
      data-stage="agent"
    >
      <CardContent className="p-4 flex items-start gap-3">
        <PlugZap className="text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" size={20} />
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <div className="text-sm font-semibold text-orange-700 dark:text-orange-300">
              Agent request failed — {describeAgentErrorKind(ae?.kind)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {agentProducedNoOutput(report)
                ? 'The agent produced no output, so this case was not judged. Re-run the case to retry the agent.'
                : 'The agent request failed part-way; partial output is shown below but no verdict was produced.'}
            </div>
          </div>
          <div className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 rounded border border-orange-200 dark:border-orange-500/30 p-2" data-testid="run-failure-cause">
            {cause || 'agent request produced no output (cause not recorded)'}
          </div>
          <div className="space-y-1">
            <Field label="Endpoint" value={ae?.endpoint ?? report.agentEndpoint} mono />
            <Field label="Waited" value={formatMs(ae?.elapsedMs ?? report.performanceMetrics?.agentDurationMs)} />
            {ae?.httpStatus !== undefined && <Field label="HTTP status" value={String(ae.httpStatus)} mono />}
            <Field label="Connector" value={report.connectorProtocol} mono />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
