/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GitCompare, ChevronDown, ChevronRight, X, Check, Loader2, RotateCcw } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { MetricComparisonPanel } from './MetricComparisonPanel';
import { ComparisonSearch } from './ComparisonSearch';
import { UseCaseComparisonTable } from './UseCaseComparisonTable';
import { RunPairSelector } from './RunPairSelector';
import { VerdictStrip } from './VerdictStrip';
import { ComparisonDeepDive, DeepDiveRunMeta } from './ComparisonDeepDive';
import { FailureClusterPanel } from './FailureClusterPanel';
import { ComparisonOverlapBanner } from './ComparisonOverlapBanner';
import { extractFirstDivergence } from '@/services/trajectoryDiffService';
import type { FailureCluster, FailureCaseEvidenceInput } from '@/services/client/comparisonClusterApi';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import { asyncBenchmarkStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { listEvaluationRuns, getEvaluationRun, executeEvaluationRun } from '@/services/client';
import {
  calculateRunAggregates,
  buildTestCaseComparisonRows,
  filterRowsByCategory,
  filterRowsByStatus,
  getRealTestCaseMeta,
  countRowsByStatus,
  calculateRowStatus,
  collectRunIdsFromReports,
  calculateCombinedScore,
  detectComparisonMode,
  computeTestCaseOverlap,
  ComparisonMode,
  RowStatus,
} from '@/services/comparisonService';
import { fetchBatchMetrics } from '@/services/metrics';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime, getModelName } from '@/lib/utils';
import { Category, Benchmark, BenchmarkRun, EvaluationReport, EvaluationRun, RunAggregateMetrics, TestCaseComparisonRow, TraceMetrics, TestCase } from '@/types';

type StatusFilter = 'all' | 'passed' | 'failed' | 'mixed';

const getAgentName = (key: string) =>
  DEFAULT_CONFIG.agents.find(a => a.key === key)?.name || key;

/** A selectable run plus the benchmark it came from (label only). */
interface RunPoolEntry {
  run: BenchmarkRun;
  benchmarkId?: string;
  benchmarkName?: string;
  kind: 'benchmark' | 'eval-run';
}




// ─── Main Component ──────────────────────────────────────────────────────────

export const ComparisonPage: React.FC = () => {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // All benchmarks for the selector
  const [allBenchmarks, setAllBenchmarks] = useState<Benchmark[]>([]);

  // All test cases for name lookup
  const [allTestCases, setAllTestCases] = useState<TestCase[]>([]);

  // State for benchmark and data
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  // The selectable pool of runs. In benchmark-scoped mode this is that
  // benchmark's runs; in unscoped mode (`/compare?runs=a,b`) it's the union of
  // every benchmark-embedded run and every top-level evaluation-run. Each entry
  // carries the benchmark it came from (if any) purely for labeling — comparison
  // itself is a test-case-level primitive and does not require a benchmark.
  const [runPool, setRunPool] = useState<RunPoolEntry[]>([]);
  const [reports, setReports] = useState<Record<string, EvaluationReport>>({});
  // True while the per-cell reports are still loading (phase 2, after the runs
  // load). Without this the table renders every cell as 'missing' (empty) for
  // the whole fetch window — the "no runs on each test case" symptom.
  const [reportsLoading, setReportsLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [traceMetricsMap, setTraceMetricsMap] = useState<Map<string, TraceMetrics>>(new Map());

  // Derived: the flat run list (pool minus benchmark labels) used everywhere
  // the page previously read `allRuns`.
  const allRuns = useMemo((): BenchmarkRun[] => runPool.map(p => p.run), [runPool]);
  const getRunBenchmarkLabel = useCallback(
    (runId: string) => runPool.find(p => p.run.id === runId)?.benchmarkName,
    [runPool]
  );

  // State for selected runs (initialized from URL)
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // State for filters
  const [labelFilter, setLabelFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [testCaseFilter, setTestCaseFilter] = useState<string | null>(null);
  // All standalone evaluation runs (for the run-search universe).
  const [allEvalRuns, setAllEvalRuns] = useState<EvaluationRun[]>([]);
  // 'differences' means "show only the rows where the runs disagree" (regression
  // | improvement | mixed) — hides 'neutral' rows so failures stand out. Default
  // to it; the user came here for differences, not to scroll past green checkmarks.
  const [rowStatusFilter, setRowStatusFilter] = useState<RowStatus | 'all' | 'differences'>('differences');

  // Trajectory gating state
  const [trajectoryTargetTestCase, setTrajectoryTargetTestCase] = useState<string | null>(null);
  // Trace-window hints (serviceName + window) resolved by the deep-dive agent,
  // keyed by agent runId — lets the Traces tab render closed-source spans
  // (Strategy C) and lets span citations deep-link.
  const [traceWindowAgents, setTraceWindowAgents] = useState<Map<string, { serviceName?: string; startedAt: number; endedAt: number }>>(new Map());
  // A span citation the user clicked in the deep-dive → expand that test case,
  // switch it to the Traces tab, and highlight the span. nonce re-triggers.
  const [spanDeepLink, setSpanDeepLink] = useState<{ testCaseId: string; runId: string; spanId: string; nonce: number } | null>(null);
  const [showRunPairSelector, setShowRunPairSelector] = useState(false);
  const [trajectoryRunPair, setTrajectoryRunPair] = useState<[string, string] | null>(null);

  // User-overridden mode (null means use detected mode)
  const [modeOverride, setModeOverride] = useState<ComparisonMode | null>(null);

  // Failure-cluster state — populated by the FailureClusterPanel after analysis.
  // Drives row dot-coloring and the cluster-driven case filter below.
  const [failureClusters, setFailureClusters] = useState<FailureCluster[]>([]);
  const [clusterCaseFilter, setClusterCaseFilter] = useState<{ caseIds: string[]; clusterName: string } | null>(null);

  // Load all test cases (name lookup). Benchmarks list is loaded by the pool
  // loader below and stored in allBenchmarks for the selector.
  useEffect(() => {
    (async () => {
      try {
        const tcs = await asyncTestCaseStorage.getAll();
        setAllTestCases(tcs);
      } catch (err) {
        console.error('Failed to load test cases:', err);
      }
    })();
  }, []);

  // Helper: pick latest runs by date (up to 2 if available)
  const pickLatestRuns = (runs: BenchmarkRun[]) => {
    const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sorted.slice(0, Math.min(2, sorted.length)).map(r => r.id);
  };

  // Load the run pool.
  //
  // Two modes, but a single primitive underneath — a set of runs keyed by id:
  //   - scoped   (`/compare/:benchmarkId`): pool = that benchmark's runs.
  //   - unscoped (`/compare?runs=a,b`):     pool = union of every benchmark's
  //                                         runs ∪ every top-level eval-run.
  // In both modes comparison happens at the test-case level (see
  // buildTestCaseComparisonRows / computeTestCaseOverlap); the benchmark is only
  // context for selecting + labeling runs, never a requirement.
  useEffect(() => {
    const loadPool = async () => {
      setIsLoading(true);
      try {
        const [bms, evalRuns] = await Promise.all([
          asyncBenchmarkStorage.getAll(),
          listEvaluationRuns({ size: 500 }).then(r => r.evaluationRuns).catch(() => []),
        ]);
        setAllBenchmarks(bms);
        setAllEvalRuns(evalRuns);
        const benchNameById = new Map(bms.map(b => [b.id, b.name] as const));

        const pool: RunPoolEntry[] = [];
        const seen = new Set<string>();

        if (benchmarkId) {
          // Scoped: resolve this benchmark; its runs are the pool.
          const bench = bms.find(b => b.id === benchmarkId) ?? await asyncBenchmarkStorage.getById(benchmarkId);
          if (!bench) {
            navigate('/benchmarks');
            return;
          }
          setBenchmark(bench);
          for (const run of bench.runs || []) {
            if (seen.has(run.id)) continue;
            seen.add(run.id);
            pool.push({ run, benchmarkId: bench.id, benchmarkName: bench.name, kind: 'benchmark' });
          }
        } else {
          // Unscoped: union of every benchmark-embedded run + every eval-run.
          setBenchmark(null);
          for (const bm of bms) {
            for (const run of bm.runs || []) {
              if (seen.has(run.id)) continue;
              seen.add(run.id);
              pool.push({ run, benchmarkId: bm.id, benchmarkName: bm.name, kind: 'benchmark' });
            }
          }
          for (const er of evalRuns) {
            if (seen.has(er.id)) continue;
            seen.add(er.id);
            pool.push({
              run: er as unknown as BenchmarkRun,
              benchmarkId: er.benchmarkId,
              benchmarkName: er.benchmarkId ? (benchNameById.get(er.benchmarkId) ?? er.benchmarkId) : undefined,
              kind: 'eval-run',
            });
          }
        }

        // Resolve any URL-referenced runs that aren't in the pool yet (e.g.
        // ad-hoc eval-runs older than the list page size). This is what makes
        // `/compare?runs=<adhoc-a>,<adhoc-b>` work even with benchmarkId: None.
        const urlRunIds = searchParams.get('runs')?.split(',').filter(Boolean) || [];
        const missing = urlRunIds.filter(id => !seen.has(id));
        if (missing.length > 0) {
          const fetched = await Promise.all(missing.map(id => getEvaluationRun(id).catch(() => null)));
          for (const er of fetched) {
            if (er && !seen.has(er.id)) {
              seen.add(er.id);
              pool.push({
                run: er as unknown as BenchmarkRun,
                benchmarkId: er.benchmarkId,
                benchmarkName: er.benchmarkId ? (benchNameById.get(er.benchmarkId) ?? er.benchmarkId) : undefined,
                kind: 'eval-run',
              });
            }
          }
        }

        setRunPool(pool);

        // Initialize selection from URL; fall back to latest-2 only in scoped
        // mode (unscoped with no `runs` shows the picker prompt instead).
        const poolIds = new Set(pool.map(p => p.run.id));
        const validUrl = urlRunIds.filter(id => poolIds.has(id));
        if (validUrl.length >= 1) {
          setSelectedRunIds(validUrl);
        } else if (benchmarkId) {
          setSelectedRunIds(pickLatestRuns(pool.map(p => p.run)));
        } else {
          setSelectedRunIds([]);
        }
      } catch (err) {
        console.error('[ComparisonPage] Failed to load run pool:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkId, navigate]);

  // Sync selectedRunIds when URL changes externally (e.g. assistant nav).
  useEffect(() => {
    const urlRunIds = searchParams.get('runs')?.split(',').filter(Boolean) || [];
    if (urlRunIds.length > 0 && allRuns.length > 0) {
      const validRunIds = urlRunIds.filter(id => allRuns.some(r => r.id === id));
      if (validRunIds.length > 0) {
        setSelectedRunIds(prev => {
          const same = prev.length === validRunIds.length && validRunIds.every(id => prev.includes(id));
          return same ? prev : validRunIds;
        });
      }
    }
  }, [searchParams, allRuns]);

  // Fetch reports for the currently-selected runs (lazily; the unscoped pool can
  // be large so we never prefetch reports for the whole pool).
  useEffect(() => {
    const loadReports = async () => {
      const selected = runPool.filter(p => selectedRunIds.includes(p.run.id));
      const reportIds = new Set<string>();
      selected.forEach(({ run }) => {
        Object.values(run.results || {}).forEach(result => {
          if (result.reportId) reportIds.add(result.reportId);
        });
      });
      const missing = Array.from(reportIds).filter(id => !reports[id]);
      if (missing.length === 0) return;
      setReportsLoading(true);
      try {
        // ONE batched request (server fans out in parallel) instead of N
        // per-report round-trips — cells populate in a single OpenSearch hop.
        const fetched = await asyncRunStorage.getReportsByIds(missing);
        if (Object.keys(fetched).length > 0) {
          setReports(prev => ({ ...prev, ...fetched }));
        }
      } finally {
        setReportsLoading(false);
      }
    };
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPool, selectedRunIds]);

  // Fetch trace metrics for the selected runs.
  useEffect(() => {
    const loadTraceMetrics = async () => {
      const selectedRunsForMetrics = runPool.filter(p => selectedRunIds.includes(p.run.id)).map(p => p.run);
      const runIds = collectRunIdsFromReports(selectedRunsForMetrics, reports);
      if (runIds.length === 0) { setTraceMetricsMap(new Map()); return; }
      try {
        const { metrics } = await fetchBatchMetrics(runIds);
        const map = new Map<string, TraceMetrics>();
        metrics.forEach(m => { if (m.runId && !('error' in m)) map.set(m.runId, m as TraceMetrics); });
        setTraceMetricsMap(map);
      } catch (error) {
        console.warn('[ComparisonPage] Failed to fetch trace metrics:', error);
      }
    };
    if (selectedRunIds.length > 0 && Object.keys(reports).length > 0) loadTraceMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPool, selectedRunIds, reports]);

  // Update URL when selection changes.
  //   - scoped:   drop the `runs` param when the whole benchmark is selected
  //               (keeps the URL clean / matches prior behavior).
  //   - unscoped: runs ARE the source of truth, so always serialize them.
  const updateSelection = (runIds: string[]) => {
    setSelectedRunIds(runIds);
    if (benchmarkId) {
      if (runIds.length > 0 && runIds.length < allRuns.length) {
        setSearchParams({ runs: runIds.join(',') }, { replace: true });
      } else if (runIds.length === allRuns.length) {
        setSearchParams({}, { replace: true });
      }
    } else {
      if (runIds.length > 0) {
        setSearchParams({ runs: runIds.join(',') }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    }
  };

  // Toggle run
  const toggleRun = (runId: string) => {
    const newSelection = selectedRunIds.includes(runId)
      ? selectedRunIds.filter(id => id !== runId)
      : [...selectedRunIds, runId];
    if (newSelection.length < 1) return;
    updateSelection(newSelection);
  };

  // Handle benchmark change — navigate to new URL. `__all__` switches to the
  // unscoped, runs-first view (`/compare`).
  const handleBenchmarkChange = (newBmId: string) => {
    if (newBmId === '__all__') {
      if (benchmarkId) {
        setSelectedRunIds([]);
        navigate('/compare', { replace: true });
      }
      return;
    }
    if (newBmId !== benchmarkId) {
      setSelectedRunIds([]);
      navigate(`/compare/${newBmId}`, { replace: true });
    }
  };

  // Trajectory run-pair handlers
  const handleRunPairSelect = (runA: string, runB: string) => {
    setTrajectoryRunPair([runA, runB]);
    setShowRunPairSelector(false);
  };

  const handleRunPairCancel = () => {
    setTrajectoryTargetTestCase(null);
    setTrajectoryRunPair(null);
    setShowRunPairSelector(false);
  };

  const selectedRuns = useMemo((): BenchmarkRun[] => allRuns.filter(r => selectedRunIds.includes(r.id)), [allRuns, selectedRunIds]);

  // Test-level overlap across the selected runs — the honesty surface for
  // benchmark-free comparison (which cases overlap, which don't).
  const overlap = useMemo(() => computeTestCaseOverlap(selectedRuns), [selectedRuns]);

  const detectedMode = useMemo((): ComparisonMode => detectComparisonMode(selectedRuns), [selectedRuns]);
  const mode: ComparisonMode = modeOverride ?? detectedMode;

  const runAggregates = useMemo((): RunAggregateMetrics[] => {
    return selectedRuns.map(run => {
      const base = calculateRunAggregates(run, reports);
      let totalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCostUsd = 0, totalDurationMs = 0, totalLlmCalls = 0, totalToolCalls = 0, mc = 0;
      for (const result of Object.values(run.results)) {
        const report = reports[result.reportId];
        if (report?.runId) {
          const tm = traceMetricsMap.get(report.runId);
          if (tm) { totalTokens += tm.totalTokens || 0; totalInputTokens += tm.inputTokens || 0; totalOutputTokens += tm.outputTokens || 0; totalCostUsd += tm.costUsd || 0; totalDurationMs += tm.durationMs || 0; totalLlmCalls += tm.llmCalls || 0; totalToolCalls += tm.toolCalls || 0; mc++; }
        }
      }
      // Fall back to the run-level performance metrics when no traces are
      // available — prefer real data we already have over showing "0ms" /
      // "$0.00" (which reads as "this agent costs nothing" in the verdict).
      const perf = (run as BenchmarkRun & { performanceMetrics?: { avgTestCaseDurationMs?: number; durationMs?: number } }).performanceMetrics;
      const fallbackAvgDurationMs = perf?.avgTestCaseDurationMs ?? (perf?.durationMs && base.totalTestCases ? Math.round(perf.durationMs / base.totalTestCases) : undefined);
      return {
        ...base,
        totalTokens: mc > 0 ? totalTokens : undefined,
        totalInputTokens: mc > 0 ? totalInputTokens : undefined,
        totalOutputTokens: mc > 0 ? totalOutputTokens : undefined,
        totalCostUsd: mc > 0 ? totalCostUsd : undefined,
        avgDurationMs: mc > 0 ? Math.round(totalDurationMs / mc) : fallbackAvgDurationMs,
        totalLlmCalls: mc > 0 ? totalLlmCalls : undefined,
        totalToolCalls: mc > 0 ? totalToolCalls : undefined,
      };
    });
  }, [selectedRuns, reports, traceMetricsMap]);

  // Test case name lookup — checks loaded test cases first, falls back to getRealTestCaseMeta (static data)
  const getTestCaseMeta = useCallback((testCaseId: string) => {
    const tc = allTestCases.find(t => t.id === testCaseId);
    if (tc) {
      return {
        id: tc.id,
        name: tc.name,
        labels: tc.labels,
        category: tc.category,
        difficulty: tc.difficulty,
        version: `v${tc.currentVersion}`,
      };
    }
    return getRealTestCaseMeta(testCaseId);
  }, [allTestCases]);

  const allComparisonRows = useMemo((): TestCaseComparisonRow[] => buildTestCaseComparisonRows(selectedRuns, reports, getTestCaseMeta), [selectedRuns, reports, getTestCaseMeta]);

  // ── Re-run comparison ───────────────────────────────────────────────
  // Re-execute every compared run's config on the SAME test cases, then open
  // the fresh comparison. Enabled ONLY when the runs are fully comparable
  // (identical test-case sets) — otherwise "re-run the comparison" is
  // ill-defined. Each run keeps its own agent/model/evaluator/judge; only the
  // test-case set is pinned to the shared intersection. Navigates as soon as
  // both runs START (the runs finish server-side regardless of the client).
  const [rerunning, setRerunning] = useState(false);
  const handleRerunComparison = useCallback(() => {
    if (!overlap.fullyOverlapping || rerunning) return;
    const ids = allComparisonRows.map(r => r.testCaseId);
    if (ids.length === 0) return;
    if (!window.confirm(
      `Re-run ${selectedRuns.length} agent config(s) on the same ${ids.length} test case${ids.length === 1 ? '' : 's'}? This launches fresh evaluation runs.`
    )) return;
    setRerunning(true);
    const newRunId: Record<string, string> = {};
    const openWhenAllStarted = () => {
      if (selectedRuns.every(r => newRunId[r.id])) {
        navigate(`/compare?runs=${selectedRuns.map(r => newRunId[r.id]).join(',')}`);
      }
    };
    selectedRuns.forEach(run => {
      executeEvaluationRun(
        {
          name: `Re-run: ${run.name || getAgentName(run.agentKey)}`,
          sources: [{ type: 'test-case-ids', ids }] as any,
          agentKey: run.agentKey,
          modelId: (run as any).modelId ?? '',
          evaluatorId: (run as any).evaluatorId,
          judgeModelId: (run as any).judgeModelId,
          benchmarkId: (run as any).benchmarkId,
          trigger: 'ui',
        },
        () => {},
        (started) => { newRunId[run.id] = started.runId; openWhenAllStarted(); },
      ).catch(err => {
        console.error('[ComparisonPage] re-run failed:', err);
        setRerunning(false);
      });
    });
  }, [overlap.fullyOverlapping, rerunning, allComparisonRows, selectedRuns, navigate]);

  const referenceRunId = useMemo(() => {
    const sorted = [...selectedRuns].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return sorted[0]?.id ?? '';
  }, [selectedRuns]);

  const rowStatusCounts = useMemo(() => countRowsByStatus(allComparisonRows, referenceRunId), [allComparisonRows, referenceRunId]);

  const filteredRows = useMemo((): TestCaseComparisonRow[] => {
    let rows = allComparisonRows;
    if (labelFilter !== 'all') rows = rows.filter(r => (r.labels || []).includes(labelFilter));
    if (testCaseFilter) rows = rows.filter(r => r.testCaseId === testCaseFilter);
    rows = filterRowsByStatus(rows, statusFilter, selectedRunIds);
    if (rowStatusFilter === 'differences') {
      rows = rows.filter(row => calculateRowStatus(row, referenceRunId) !== 'neutral');
    } else if (rowStatusFilter !== 'all') {
      rows = rows.filter(row => calculateRowStatus(row, referenceRunId) === rowStatusFilter);
    }
    if (clusterCaseFilter) {
      const allow = new Set(clusterCaseFilter.caseIds);
      rows = rows.filter(row => allow.has(row.testCaseId));
    }
    return rows;
  }, [allComparisonRows, labelFilter, testCaseFilter, statusFilter, selectedRunIds, rowStatusFilter, referenceRunId, clusterCaseFilter]);

  // If the filter is 'differences' but there are no differences (all-pass /
  // all-fail benchmark), automatically show everything so the user isn't
  // staring at an empty table.
  //
  // Latched with a ref so this only fires once per filter mode — without
  // the latch, `rowStatusCounts` recomputes on every poll/refresh of the
  // underlying runs, and even though the filter is already 'all' by then,
  // the effect's deps fire and it re-evaluates the same condition
  // repeatedly. With the latch we also reset back to 'unfired' when the
  // user manually flips the filter back to 'differences' — that's a fresh
  // intent that should be allowed to auto-switch again if the data still
  // shows zero differences.
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (rowStatusFilter !== 'differences') {
      autoSwitchedRef.current = false;
      return;
    }
    if (autoSwitchedRef.current) return;
    const totalDifferences =
      rowStatusCounts.regression + rowStatusCounts.improvement + rowStatusCounts.mixed;
    if (totalDifferences === 0 && rowStatusCounts.neutral > 0) {
      setRowStatusFilter('all');
      autoSwitchedRef.current = true;
    }
  }, [rowStatusFilter, rowStatusCounts]);

  // Build the regressed-case evidence the cluster panel will analyze. Picks
  // a winner/loser per row by combined score, mirroring DivergencePreviewRow
  // so the divergence summary the LLM sees matches what the user sees.
  const regressedEvidence = useMemo<{
    cases: FailureCaseEvidenceInput[];
    loserLabel: string;
    winnerLabel: string;
  }>(() => {
    const cases: FailureCaseEvidenceInput[] = [];
    let bestLoserAgent = '';
    let bestWinnerAgent = '';

    // We want every row where there's a pass/fail disagreement between
    // the selected runs — regardless of which is the baseline. The cluster
    // story is "the LOSER failed where the WINNER passed", so we collect
    // any row where at least one run failed AND at least one passed.
    const disagreementRows = allComparisonRows.filter(row => {
      const completed = selectedRuns.filter(r => row.results[r.id]?.status === 'completed');
      if (completed.length < 2) return false;
      let anyPassed = false;
      let anyFailed = false;
      for (const r of completed) {
        const result = row.results[r.id];
        if (result?.passFailStatus === 'passed') anyPassed = true;
        if (result?.passFailStatus === 'failed') anyFailed = true;
      }
      return anyPassed && anyFailed;
    });

    for (const row of disagreementRows) {
      const completed = selectedRuns.filter(r => row.results[r.id]?.status === 'completed');
      if (completed.length < 2) continue;

      let winnerRun = completed[0];
      let loserRun = completed[0];
      let winnerScore = -Infinity;
      let loserScore = Infinity;
      for (const r of completed) {
        const result = row.results[r.id];
        if (!result) continue;
        const score = calculateCombinedScore(result);
        if (score > winnerScore) { winnerScore = score; winnerRun = r; }
        if (score < loserScore) { loserScore = score; loserRun = r; }
      }
      if (winnerRun.id === loserRun.id) continue;

      const winnerReport = reports[row.results[winnerRun.id]?.reportId ?? ''];
      const loserReport = reports[row.results[loserRun.id]?.reportId ?? ''];

      let firstDivergence: FailureCaseEvidenceInput['firstDivergence'] | undefined;
      if (winnerReport?.trajectory && loserReport?.trajectory) {
        const fd = extractFirstDivergence(loserReport.trajectory, winnerReport.trajectory);
        if (fd) {
          firstDivergence = {
            stepIndex: fd.index,
            type: fd.type,
            baselineSummary: fd.baselineSummary,
            comparisonSummary: fd.comparisonSummary,
          };
        }
      }

      cases.push({
        caseId: row.testCaseId,
        caseName: row.testCaseName,
        judgeReasoning: loserReport?.llmJudgeReasoning,
        improvementStrategies: loserReport?.improvementStrategies,
        firstDivergence,
      });

      // Track agent labels — used to label the cluster prompt. Pick the most
      // common winner/loser pair seen across regressed rows.
      if (!bestLoserAgent) bestLoserAgent = loserRun.agentKey;
      if (!bestWinnerAgent) bestWinnerAgent = winnerRun.agentKey;
    }

    return {
      cases,
      loserLabel: bestLoserAgent ? getAgentName(bestLoserAgent) : 'losing run',
      winnerLabel: bestWinnerAgent ? getAgentName(bestWinnerAgent) : 'winning run',
    };
  }, [allComparisonRows, referenceRunId, selectedRuns, reports]);

  // Map caseId -> cluster index for row dot-coloring in the table.
  const clusterByCaseId = useMemo(() => {
    const map = new Map<string, number>();
    failureClusters.forEach((c, idx) => {
      for (const id of c.caseIds) {
        if (!map.has(id)) map.set(id, idx);
      }
    });
    return map;
  }, [failureClusters]);

  // When the user picks a different benchmark / runs, drop the cluster filter.
  useEffect(() => {
    setClusterCaseFilter(null);
    setFailureClusters([]);
  }, [benchmarkId, selectedRunIds.join(',')]);

  const categories = useMemo(() => Array.from(new Set(allComparisonRows.map(r => r.category))).sort(), [allComparisonRows]);
  // Every label present across the compared rows — powers the "All Labels" filter.
  const allLabels = useMemo(() => Array.from(new Set(allComparisonRows.flatMap(r => r.labels || []))).sort(), [allComparisonRows]);

  // The run-search universe: every benchmark's runs + standalone eval runs +
  // whatever is currently loaded, deduped by id — so the search reaches every
  // run, not just the current benchmark's.
  const runUniverse = useMemo((): BenchmarkRun[] => {
    const map = new Map<string, BenchmarkRun>();
    for (const b of allBenchmarks) for (const r of (b.runs || [])) if (!map.has(r.id)) map.set(r.id, r);
    for (const er of allEvalRuns) if (!map.has(er.id)) map.set(er.id, er as unknown as BenchmarkRun);
    for (const r of allRuns) if (!map.has(r.id)) map.set(r.id, r);
    return Array.from(map.values());
  }, [allBenchmarks, allEvalRuns, allRuns]);

  // Apply a run selection from the search (can span benchmarks). If every run
  // is in the current context keep it in place; otherwise switch to a
  // run-centric comparison (/compare?runs=).
  const composeSelection = (ids: string[]) => {
    if (ids.length < 1) return;
    if (!benchmarkId || ids.every(id => allRuns.some(r => r.id === id))) {
      updateSelection(ids);
    } else {
      navigate(`/compare?runs=${ids.join(',')}`);
    }
  };
  const toggleRunInSearch = (runId: string) => {
    const next = selectedRunIds.includes(runId)
      ? selectedRunIds.filter(id => id !== runId)
      : [...selectedRunIds, runId];
    composeSelection(next);
  };

  // Collapsible state
  const [summaryOpen, setSummaryOpen] = useState(false);

  if (isLoading) {
    return <div className="p-6 flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="h-full flex flex-col" data-testid="comparison-page">
      {/* ── Compact Sticky Toolbar ─────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-background border-b border-border px-4 py-2 space-y-2">
        <Breadcrumbs
          items={[
            { label: 'Evaluations', href: '/evaluations/benchmarks' },
            { label: 'Compare Runs' },
          ]}
          actions={
            <>
              <ComparisonSearch
                benchmarks={allBenchmarks}
                runs={runUniverse}
                selectedRunIds={selectedRunIds}
                testCases={allComparisonRows.map(r => ({ id: r.testCaseId, name: r.testCaseName }))}
                activeTestCaseId={testCaseFilter}
                onSelectBenchmark={handleBenchmarkChange}
                onToggleRun={toggleRunInSearch}
                onSelectAllRuns={composeSelection}
                onSelectTestCase={setTestCaseFilter}
              />
              <Select value={labelFilter} onValueChange={setLabelFilter}>
                <SelectTrigger className="w-32 h-7 text-xs"><SelectValue placeholder="Labels" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Labels</SelectItem>
                  {allLabels.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="w-24 h-7 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="passed">Passed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="mixed">Mixed</SelectItem>
                </SelectContent>
              </Select>
              {/* Re-run the comparison — lives in the header (after Status) so it's
                  always reachable. Disabled unless the runs cover the identical
                  test-case set; the tooltip explains why when disabled. */}
              {selectedRuns.length >= 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  data-testid="rerun-comparison-btn"
                  disabled={!overlap.fullyOverlapping || rerunning}
                  onClick={handleRerunComparison}
                  title={overlap.fullyOverlapping
                    ? 'Re-run every compared agent on these exact test cases and open the fresh comparison'
                    : `Re-run needs all runs to cover the same test cases — they differ by ${overlap.totalTestCases - overlap.sharedTestCases}.`}
                >
                  {rerunning ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  {rerunning ? 'Launching…' : 'Re-run comparison'}
                </Button>
              )}
            </>
          }
        />
        <h1 className="sr-only" data-testid="comparison-title">Compare Runs</h1>
      </div>

      {/* ── Scrollable Results Area ─────────────────────────────── */}
      <div className="flex-1 overflow-y-auto rounded-lg">
        {selectedRuns.length >= 1 ? (
          <div className="p-4 space-y-3">
            {/* Info banner when only 1 run selected */}
            {selectedRuns.length === 1 && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-300 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300 text-xs">
                <GitCompare size={14} className="shrink-0" />
                <span>Showing results for a single run. Add at least one more run to compare differences.</span>
              </div>
            )}

            {/* Test-level overlap — honest coverage across the selected runs
                (benchmark or not). Shown for 2+ runs. */}
            {selectedRuns.length >= 2 && <ComparisonOverlapBanner overlap={overlap} />}

            {/* A/B legend — make the comparison's A vs B mapping explicit (URL
                order: A = first run, B = second). Shown for 2-run compares so
                the deep-dive, span citations and trace panes are unambiguous. */}
            {mode === 'compare' && selectedRuns.length === 2 && (
              <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="comparison-ab-legend">
                {(['A', 'B'] as const).map((ab, i) => (
                  <span key={ab} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${i === 0 ? 'bg-opensearch-blue/10 border-opensearch-blue/40' : 'bg-purple-500/10 border-purple-400/40'}`}>
                    <span className={`inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded font-bold ${i === 0 ? 'text-opensearch-blue' : 'text-purple-300'}`}>{ab}</span>
                    <span className="font-medium text-foreground">{getAgentName(selectedRuns[i].agentKey)}</span>
                    <span className="text-muted-foreground">· {getModelName(selectedRuns[i].modelId)}</span>
                  </span>
                ))}
              </div>
            )}

            {/* What's actually different — agentic, trace-grounded deep-dive
                for 2-run compares; classic VerdictStrip otherwise. */}
            {mode === 'compare' && runAggregates.length === 2 ? (
              <ComparisonDeepDive
                runs={selectedRuns}
                rows={allComparisonRows}
                reports={reports}
                getAgentName={getAgentName}
                onWindowAgents={(metaRuns: DeepDiveRunMeta[]) => {
                  const m = new Map<string, { serviceName?: string; startedAt: number; endedAt: number }>();
                  metaRuns.forEach((r) => {
                    const win = { serviceName: r.serviceName, startedAt: r.startedAt, endedAt: r.endedAt };
                    // Key by reportId AND the deep-dive's (agent) runId. The
                    // Traces tab looks the window up by the report's *client*
                    // run id, which toTestCaseRun maps to the OTel traceId — not
                    // the agent runId the deep-dive returns — so keying only by
                    // runId missed, the Strategy-C window was never fetched, and
                    // some cited spans couldn't be opened. reportId is stable on
                    // both sides; the lookup tries it first.
                    if (r.reportId) m.set(r.reportId, win);
                    if (r.runId) m.set(r.runId, win);
                  });
                  setTraceWindowAgents(m);
                }}
                onSpanLink={(testCaseId, runId, spanId) =>
                  setSpanDeepLink({ testCaseId, runId, spanId, nonce: Date.now() })
                }
              />
            ) : (
              <VerdictStrip mode={mode} runs={runAggregates} />
            )}

            {/* Diagnosis — failure pattern clustering across regressed cases.
                Renders only when there are regressed rows to analyze. */}
            {regressedEvidence.cases.length > 0 && (
              <FailureClusterPanel
                loserLabel={regressedEvidence.loserLabel}
                winnerLabel={regressedEvidence.winnerLabel}
                cases={regressedEvidence.cases}
                activeCaseFilter={clusterCaseFilter?.caseIds}
                onClustersChange={setFailureClusters}
                onFilterByCases={(caseIds, clusterName) => {
                  // Toggle off if the same cluster is clicked twice.
                  setClusterCaseFilter(prev =>
                    prev && prev.clusterName === clusterName ? null : { caseIds, clusterName }
                  );
                }}
              />
            )}

            {/* Detailed metrics — power-user surface, collapsed by default */}
            <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
              <CollapsibleTrigger asChild>
                <button className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg border border-border/50 hover:bg-muted/30 transition-colors">
                  <ChevronRight size={14} className={`text-muted-foreground transition-transform ${summaryOpen ? 'rotate-90' : ''}`} />
                  <span className="text-xs font-medium">Detailed metrics</span>
                  {!summaryOpen && (
                    <span className="text-[10px] text-muted-foreground ml-1">
                      Bar chart of quality metrics + full metrics matrix
                    </span>
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 mt-2">
                <MetricComparisonPanel runs={runAggregates} />
              </CollapsibleContent>
            </Collapsible>

            {/* ── Table Compare — primary content ──────────────── */}
            <section>
              {/* Header with filter pills */}
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-sm font-semibold">Table Compare</h2>
                  <div className="flex items-center gap-1 ml-2">
                    {(() => {
                      const totalDiffs =
                        rowStatusCounts.regression + rowStatusCounts.improvement + rowStatusCounts.mixed;
                      return (
                        <Badge
                          variant="outline"
                          className={`cursor-pointer text-[9px] px-2 py-0.5 transition-colors ${rowStatusFilter === 'differences' ? 'bg-primary/20 border-primary text-primary' : 'hover:bg-muted'}`}
                          onClick={() => setRowStatusFilter('differences')}
                          title="Show only the rows where the runs disagree"
                        >
                          {totalDiffs} differences
                        </Badge>
                      );
                    })()}
                    <Badge
                      variant="outline"
                      className={`cursor-pointer text-[9px] px-2 py-0.5 transition-colors ${rowStatusFilter === 'all' ? 'bg-primary/20 border-primary text-primary' : 'hover:bg-muted'}`}
                      onClick={() => setRowStatusFilter('all')}
                    >
                      Show all ({allComparisonRows.length})
                    </Badge>
                    {rowStatusCounts.regression > 0 && (
                      <Badge variant="outline" className={`cursor-pointer text-[9px] px-2 py-0.5 border-red-500/30 ${rowStatusFilter === 'regression' ? 'bg-red-500/10 text-red-400' : 'hover:bg-red-500/5'}`} onClick={() => setRowStatusFilter('regression')}>
                        {rowStatusCounts.regression} regressed
                      </Badge>
                    )}
                    {rowStatusCounts.improvement > 0 && (
                      <Badge variant="outline" className={`cursor-pointer text-[9px] px-2 py-0.5 border-blue-500/30 ${rowStatusFilter === 'improvement' ? 'bg-blue-500/10 text-blue-400' : 'hover:bg-blue-500/5'}`} onClick={() => setRowStatusFilter('improvement')}>
                        {rowStatusCounts.improvement} improved
                      </Badge>
                    )}
                    {rowStatusCounts.mixed > 0 && (
                      <Badge variant="outline" className={`cursor-pointer text-[9px] px-2 py-0.5 border-amber-500/30 ${rowStatusFilter === 'mixed' ? 'bg-amber-500/10 text-amber-400' : 'hover:bg-amber-500/5'}`} onClick={() => setRowStatusFilter('mixed')}>
                        {rowStatusCounts.mixed} mixed
                      </Badge>
                    )}
                    {clusterCaseFilter && (
                      <Badge
                        variant="outline"
                        className="cursor-pointer text-[9px] px-2 py-0.5 border-purple-500/30 bg-purple-500/10 text-purple-300 inline-flex items-center gap-1"
                        onClick={() => setClusterCaseFilter(null)}
                        title="Click to clear cluster filter"
                      >
                        Cluster: {clusterCaseFilter.clusterName}
                        <X size={9} />
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {rowStatusFilter === 'differences' && rowStatusCounts.neutral > 0
                    ? `Showing ${filteredRows.length} differing case${filteredRows.length === 1 ? '' : 's'} · ${rowStatusCounts.neutral} unchanged hidden — click "Show all" above to include them`
                    : 'Click a row to expand the side-by-side diff'}
                </p>
              </div>

              {/* Run pair selector for trajectory comparison (shown when > 2 runs) */}
              {showRunPairSelector && trajectoryTargetTestCase && (
                <RunPairSelector
                  runs={selectedRuns}
                  selectedRunIds={selectedRunIds}
                  onSelect={handleRunPairSelect}
                  onCancel={handleRunPairCancel}
                />
              )}

              {/* Comparison table */}
              <UseCaseComparisonTable
                reportsLoading={reportsLoading}
                rows={filteredRows}
                runs={selectedRuns}
                reports={reports}
                referenceRunId={referenceRunId}
                clusterByCaseId={clusterByCaseId}
                onFilterLabel={setLabelFilter}
                activeLabel={labelFilter === 'all' ? null : labelFilter}
                trajectoryRunPair={trajectoryRunPair}
                trajectoryTargetTestCase={trajectoryTargetTestCase}
                spanDeepLink={spanDeepLink}
                windowAgentsByRunId={traceWindowAgents}
                onTrajectoryRequest={(testCaseId) => {
                  setTrajectoryTargetTestCase(testCaseId);
                  setTrajectoryRunPair(null);
                  setShowRunPairSelector(true);
                }}
              />
              {filteredRows.length === 0 && allComparisonRows.length > 0 && (
                <p className="text-sm text-muted-foreground text-center mt-3">No test cases match the current filters</p>
              )}
            </section>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-muted-foreground">
            <GitCompare className="h-10 w-10 mb-3 opacity-50" />
            <p className="text-sm">Select runs from the dropdown above to start comparing</p>
          </div>
        )}
      </div>
    </div>
  );
};
