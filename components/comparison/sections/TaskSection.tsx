/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TaskSection — the persistent "what test ran" strip shown at the top of a
 * comparison expanded row, above the Trajectory / Traces / Judge tabs.
 *
 * Answers "what did we actually ask the agents to do?" the instant a row is
 * expanded, and stays as shared context while the user flips tabs. The prompt
 * is identical for every run in a row (one test case per row), so we show it
 * once. Lazily loads the full test-case doc (initialPrompt + description +
 * labels) by id — only when a row is expanded. Degrades silently (renders
 * nothing) if the test case can't be loaded, so it never blocks the row.
 *
 * Grading ("what's checked") is intentionally left to the Judge tab to avoid
 * duplication; this strip is about the INPUT.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, ExternalLink, Loader2 } from 'lucide-react';
import { TestCase } from '@/types';
import { asyncTestCaseStorage } from '@/services/storage';

interface TaskSectionProps {
  testCaseId: string;
}

export const TaskSection: React.FC<TaskSectionProps> = ({ testCaseId }) => {
  const [testCase, setTestCase] = useState<TestCase | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    asyncTestCaseStorage
      .getById(testCaseId)
      .then((tc) => {
        if (!cancelled) {
          setTestCase(tc);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTestCase(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [testCaseId]);

  if (loading) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card/40 p-3 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" /> Loading task…
      </div>
    );
  }

  // Don't block the row if the test case couldn't be loaded.
  if (!testCase) return null;

  return (
    <div className="mb-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ClipboardList size={13} className="text-opensearch-blue" />
          Task
          <span className="font-normal text-muted-foreground/70">· same prompt for both agents</span>
        </div>
        <Link
          to={`/evals3/test-cases/${testCaseId}`}
          className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-opensearch-blue hover:underline"
        >
          View full test case <ExternalLink size={11} />
        </Link>
      </div>

      {testCase.description && (
        <p className="mb-2 text-xs text-muted-foreground">{testCase.description}</p>
      )}

      {testCase.initialPrompt && (
        <div className="whitespace-pre-wrap break-words rounded border border-border border-l-2 border-l-opensearch-blue/40 bg-muted/30 p-2.5 text-[12.5px] leading-relaxed text-foreground/90">
          {testCase.initialPrompt}
        </div>
      )}
    </div>
  );
};
