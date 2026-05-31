/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for failure clustering on the comparison page.
 */

import type { ImprovementStrategy } from '@/types';

export type ClusterType = 'knowledge' | 'tool_gap' | 'reasoning' | 'other';

export interface FailureCluster {
  name: string;
  summary: string;
  caseIds: string[];
  exampleEvidence?: string;
  clusterType: ClusterType;
}

export interface FailureCaseEvidenceInput {
  caseId: string;
  caseName?: string;
  judgeReasoning?: string;
  improvementStrategies?: ImprovementStrategy[];
  firstDivergence?: {
    stepIndex: number;
    type: 'added' | 'removed' | 'modified';
    baselineSummary?: string;
    comparisonSummary?: string;
  };
}

export interface ClusterFailuresRequest {
  loserLabel: string;
  winnerLabel: string;
  cases: FailureCaseEvidenceInput[];
  force?: boolean;
}

export interface ClusterFailuresResponse {
  clusters: FailureCluster[];
  totalFailures: number;
  modelId: string;
}

export async function clusterFailures(
  req: ClusterFailuresRequest
): Promise<ClusterFailuresResponse> {
  const response = await fetch('/api/comparison/cluster-failures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const data = await response.json();
      detail = data?.error;
    } catch {
      /* swallow */
    }
    throw new Error(
      detail || `Failed to cluster failures: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}
