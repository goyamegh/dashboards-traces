/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * EvalRunInspectorPage — Eval Run Inspector for non-benchmark EvaluationRun docs
 *
 * Mirrors RunInspectorPage but loads from the EvaluationRun document shape
 * (testCaseSnapshots[] + results{}) used by the v2 evaluation runner. Used
 * by the SDK / file-import / directory-import / label-filter sources.
 *
 * Route: /evaluations/runs/:runId/inspect
 * Optional query: ?reportId=<id>  — pre-select a specific test case
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Clock, XCircle, Calendar } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncRunStorage } from '@/services/storage';
import { getEvaluationRun } from '@/services/client/evaluationRunsApi';
import { EvaluationReport, EvaluationRun, TestCase } from '@/types';
import { ResultStatus, getResultStatus, StatusIcon, StatusLabel } from './ResultStatus';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';
import { Breadcrumbs } from './Breadcrumbs';

interface TestCaseResult {
  testCaseId: string;
  testCase: TestCase | null;       // shim assembled from snapshot
  reportId: string | null;
  status: ResultStatus;
}

/**
 * Build a minimal TestCase-shaped object from a snapshot so the inspector
 * panel can render the test name. The panel only uses `name`; everything
 * else flows from the EvaluationReport.
 */
function snapshotToTestCaseShim(snapshot: { id: string; name: string }): TestCase {
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: '',
    labels: [],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '',
    updatedAt: '',
  } as TestCase;
}

export const EvalRunInspectorPage: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const initialSelectionDone = React.useRef(false);

  const loadData = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const evalRun = await getEvaluationRun(runId);
      if (!evalRun) {
        navigate('/evaluations/runs');
        return;
      }
      setRun(evalRun);

      const snapshotById = new Map(
        (evalRun.testCaseSnapshots || []).map(s => [s.id, s])
      );
      const tcIds = Object.keys(evalRun.results || {});

      const resultRows: TestCaseResult[] = await Promise.all(
        tcIds.map(async tcId => {
          const runResult = evalRun.results[tcId];
          let report: EvaluationReport | null = null;
          if (runResult?.reportId) {
            try {
              report = (await asyncRunStorage.getReportById(runResult.reportId)) || null;
            } catch {
              /* fallback to execution status */
            }
          }
          const status = getResultStatus(runResult as any, report);
          const snapshot = snapshotById.get(tcId);
          return {
            testCaseId: tcId,
            testCase: snapshot ? snapshotToTestCaseShim(snapshot) : null,
            reportId: runResult?.reportId || null,
            status,
          };
        })
      );

      setResults(resultRows);

      // Initial selection: prefer ?reportId= query param, then first row
      if (!initialSelectionDone.current && resultRows.length > 0) {
        const queryReportId = searchParams.get('reportId');
        const preselected = queryReportId
          ? resultRows.find(r => r.reportId === queryReportId)
          : null;
        setSelectedTcId((preselected || resultRows[0]).testCaseId);
        initialSelectionDone.current = true;
      }
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [runId, navigate, searchParams]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll for updates if running
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const interval = setInterval(loadData, 3000);
    return () => clearInterval(interval);
  }, [run?.status, loadData]);

  // Load report when selection changes
  useEffect(() => {
    if (!selectedTcId) {
      setSelectedReport(null);
      return;
    }
    const result = results.find(r => r.testCaseId === selectedTcId);
    if (!result?.reportId) {
      setSelectedReport(null);
      return;
    }
    setReportLoading(true);
    let cancelled = false;
    asyncRunStorage
      .getReportById(result.reportId)
      .then(report => {
        if (!cancelled) setSelectedReport(report || null);
      })
      .catch(() => {
        if (!cancelled) setSelectedReport(null);
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTcId, results]);

  if (loading || !run) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[calc(100vh-200px)] w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-300">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => navigate('/evaluations/runs')}
          >
            Back to Runs
          </Button>
        </div>
      </div>
    );
  }

  const passCount = results.filter(r => r.status === 'passed').length;
  const failCount = results.filter(r => r.status === 'failed').length;
  const totalCount = results.length;
  const judgedCount = passCount + failCount;
  const passRate = judgedCount > 0 ? Math.round((passCount / judgedCount) * 100) : 0;
  const selectedResult = results.find(r => r.testCaseId === selectedTcId) || null;

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const modelName = getModelName(run.modelId);

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <Breadcrumbs
          items={[
            { label: 'Runs', href: '/evaluations/runs' },
            { label: run.name || run.id, href: `/evaluations/runs/${run.id}` },
            { label: 'Inspect' },
          ]}
        />
        <div className="flex items-center justify-between mt-1">
          <h2 className="text-lg font-bold truncate">{run.name || run.id}</h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span className="flex items-center gap-1">
              <Calendar size={11} /> {formatDate(run.createdAt)}
            </span>
            <span>{agentName}</span>
            <span>{modelName}</span>
            <span className="flex items-center gap-1">
              <span className="text-green-500 font-semibold">{passCount}✓</span>
              <span className="text-red-500 font-semibold">{failCount}✗</span>
              <span>/ {totalCount}</span>
            </span>
            <span
              className={`font-semibold ${
                passRate >= 80
                  ? 'text-green-500'
                  : passRate >= 50
                  ? 'text-amber-500'
                  : 'text-red-500'
              }`}
            >
              {passRate}%
            </span>
          </div>
        </div>
      </div>

      {/* Left + Right */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel defaultSize={30} minSize={20} maxSize={45} className="border-r">
          <ScrollArea className="h-full">
            <div className="px-3 py-2 border-b">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Test Cases · {totalCount}
              </span>
            </div>
            <div className="p-1.5 space-y-0.5">
              {results.map(r => {
                const isSelected = r.testCaseId === selectedTcId;
                return (
                  <div
                    key={r.testCaseId}
                    className={`flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-blue-500/10 border-l-2 border-l-blue-500 text-foreground'
                        : 'hover:bg-muted/50 border-l-2 border-l-transparent'
                    }`}
                    onClick={() => setSelectedTcId(r.testCaseId)}
                  >
                    <StatusIcon status={r.status} size={14} />
                    <span
                      className={`text-xs flex-1 min-w-0 truncate ${
                        isSelected ? 'font-semibold' : 'font-medium'
                      }`}
                    >
                      {r.testCase?.name || r.testCaseId}
                    </span>
                    <StatusLabel status={r.status} />
                  </div>
                );
              })}
              {results.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {run.status === 'running'
                    ? 'Execution in progress…'
                    : 'No results'}
                </div>
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={70} minSize={50}>
          {selectedResult ? (
            reportLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : selectedReport ? (
              <TestCaseInspectorPanel
                report={selectedReport}
                testCase={selectedResult.testCase}
                status={selectedResult.status}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  {selectedResult.status === 'running' ? (
                    <>
                      <Loader2 size={32} className="mx-auto mb-3 text-blue-500 animate-spin" />
                      <p className="text-sm">Running agent…</p>
                    </>
                  ) : selectedResult.status === 'pending_traces' ? (
                    <>
                      <Loader2 size={32} className="mx-auto mb-3 text-amber-500 animate-spin" />
                      <p className="text-sm">Agent done — waiting for traces…</p>
                    </>
                  ) : selectedResult.status === 'pending_judgment' ? (
                    <>
                      <Loader2 size={32} className="mx-auto mb-3 text-purple-500 animate-spin" />
                      <p className="text-sm">Running LLM judge…</p>
                    </>
                  ) : selectedResult.status === 'pending' ? (
                    <>
                      <Clock size={32} className="mx-auto mb-3 text-muted-foreground" />
                      <p className="text-sm">Pending</p>
                    </>
                  ) : (
                    <>
                      <XCircle size={32} className="mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No report available</p>
                    </>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">Select a test case</p>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
