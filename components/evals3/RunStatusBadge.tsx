/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  pending: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300',
};

/**
 * Run status pill (completed/running/failed/cancelled/pending).
 *
 * Extracted from EvalRunDetailPage's inline `StatusBadge` (kept as an
 * untouched, unrouted copy there \u2014 the frozen revert backup for the
 * run-experience convergence) so RunInspectorPage can render the same
 * status pill without duplicating the color map.
 */
export function RunStatusBadge({ status }: { status: string }) {
  return (
    <span
      data-testid="run-inspector-status-badge"
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status] || STATUS_COLORS.pending}`}
    >
      {status}
    </span>
  );
}
