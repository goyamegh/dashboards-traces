/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';

const SOURCE_LABELS: Record<string, string> = {
  'benchmark': 'Benchmark',
  'test-case-ids': 'Test Cases',
  'file-import': 'File',
  'directory-import': 'Directory',
  'label-filter': 'Labels',
};

/**
 * Small badge rendering an EvaluationRun `sources[]` entry's type.
 *
 * Extracted from EvalRunDetailPage (kept as an inline, untouched copy there
 * — that file is the frozen revert backup for the run-experience
 * convergence) so RunInspectorPage can render the same source badges
 * without duplicating the label map.
 */
export function SourceBadge({ source }: { source: { type: string } }) {
  return (
    <Badge variant="outline" className="text-xs">
      {SOURCE_LABELS[source.type] || source.type}
    </Badge>
  );
}
