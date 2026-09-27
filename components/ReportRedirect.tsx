/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * ReportRedirect — resolves the retired `/runs/:runId` route.
 *
 * That route's `:runId` was a REPORT id (one test case's `EvaluationReport`),
 * not an evaluation-run id, so it cannot be redirected by a static table: the
 * report has to be fetched to learn which run (and benchmark) it belongs to.
 * Reports of a run open in the run inspector with `?reportId=` preselecting
 * the case; standalone single-case reports open on the test case's detail
 * page with `?run=` preselecting the run (lib/legacyRouteRedirects.ts →
 * `resolveReportRedirect`). A report that no longer exists lands on the
 * evaluation-runs list with an explicit message instead of a blank page.
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { asyncRunStorage } from '@/services/storage';
import { resolveReportRedirect } from '@/lib/legacyRouteRedirects';

export const ReportRedirect: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const [target, setTarget] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!runId) { setNotFound(true); return; }
    asyncRunStorage.getReportById(runId)
      .then(report => {
        if (cancelled) return;
        if (!report) { setNotFound(true); return; }
        setTarget(resolveReportRedirect(report));
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [runId]);

  if (target) return <Navigate to={target} replace />;
  if (notFound) return <Navigate to="/evaluations/runs" replace state={{ missingReportId: runId }} />;

  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="report-redirect">
      {error ? (
        <span data-testid="report-redirect-error">Could not open run report {runId}: {error}</span>
      ) : (
        <>
          <Loader2 size={16} className="animate-spin" />
          <span>Opening run report…</span>
        </>
      )}
    </div>
  );
};
