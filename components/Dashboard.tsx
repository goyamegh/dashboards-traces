/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Link, useNavigate } from 'react-router-dom';
import {
  Info, BarChart3, Play, FileText, AlertTriangle, Clock,
  CheckCircle2, XCircle, ArrowRight, TrendingDown, X,
} from 'lucide-react';
import {
  asyncBenchmarkStorage,
  asyncRunStorage,
  asyncTestCaseStorage,
} from '@/services/storage';
import { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';
import { fetchBatchMetrics } from '@/services/metrics';
import { AgentTrendChart, TrendMetric } from './charts/AgentTrendChart';
import { FirstRunExperience } from './dashboard/FirstRunExperience';
import { useDataState } from '@/hooks/useDataState';
import { isSampleDataActive } from '@/config/sampleData';
import {
  aggregateMetricsByDate,
  getUniqueAgents,
  getAgentDisplayName,
  DashboardFilter,
  TimeRange,
  TrendDataPoint,
} from '@/lib/dashboardMetrics';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime, getModelName } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// ==================== Types ====================

interface RunRow {
  run: BenchmarkRun;
  benchmarkId: string;
  benchmarkName: string;
  agentName: string;
  passed: number;
  failed: number;
  total: number;
  passRate: number;
}

interface RegressionRow extends RunRow {
  prevPassRate: number;
  delta: number; // negative
}

// ==================== Helpers ====================

function computeRunStats(run: BenchmarkRun): { passed: number; failed: number; total: number } {
  if (run.stats && run.stats.total > 0) {
    return { passed: run.stats.passed, failed: run.stats.failed, total: run.stats.total };
  }
  const results = Object.values(run.results || {});
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'completed') passed++;
    else if (r.status === 'failed' || r.status === 'cancelled') failed++;
  }
  return { passed, failed, total: results.length };
}

function buildRunRows(benchmarks: Benchmark[]): RunRow[] {
  const rows: RunRow[] = [];
  for (const bm of benchmarks) {
    for (const run of bm.runs || []) {
      const stats = computeRunStats(run);
      const agentName =
        DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name ||
        run.agentKey ||
        'Unknown';
      rows.push({
        run,
        benchmarkId: bm.id,
        benchmarkName: bm.name,
        agentName,
        passed: stats.passed,
        failed: stats.failed,
        total: stats.total,
        passRate: stats.total > 0 ? stats.passed / stats.total : 0,
      });
    }
  }
  return rows;
}

// Tailwind-friendly bar color from pass rate
function rateColor(rate: number): string {
  if (rate >= 0.9) return 'bg-emerald-500';
  if (rate >= 0.7) return 'bg-lime-500';
  if (rate >= 0.5) return 'bg-amber-500';
  if (rate >= 0.25) return 'bg-orange-500';
  return 'bg-red-500';
}

// ==================== Skeletons ====================

const DashboardSkeleton = () => (
  <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="h-[260px] lg:col-span-2" />
      <Skeleton className="h-[260px]" />
    </div>
    <Skeleton className="h-[300px]" />
  </div>
);

// ==================== Stat Pill ====================

interface StatPillProps {
  to?: string;
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  testId?: string;
}

const StatPill: React.FC<StatPillProps> = ({ to, label, value, icon: Icon, testId }) => {
  const inner = (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border bg-background/60 backdrop-blur-sm px-2.5 py-1 text-[11px] hover:bg-muted/70 transition-colors"
      data-testid={testId}
    >
      <Icon className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
};

// ==================== Filter Chips ====================

interface FilterChipsProps {
  filters: DashboardFilter;
  benchmarks: Benchmark[];
  onRemoveFilter: (type: 'benchmarkId' | 'agentKey') => void;
  onClearAll: () => void;
}

const FilterChips: React.FC<FilterChipsProps> = ({ filters, benchmarks, onRemoveFilter, onClearAll }) => {
  const hasFilters = filters.benchmarkId || filters.agentKey;
  if (!hasFilters) return null;
  const benchmarkName = filters.benchmarkId
    ? benchmarks.find(b => b.id === filters.benchmarkId)?.name || filters.benchmarkId
    : null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-2">
      <span className="text-[11px] text-muted-foreground">Filters:</span>
      {benchmarkName && (
        <Badge variant="secondary" className="gap-1 h-5 text-[10px] px-1.5">
          {benchmarkName}
          <button onClick={() => onRemoveFilter('benchmarkId')} className="ml-0.5 hover:text-foreground">
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      )}
      {filters.agentKey && (
        <Badge variant="secondary" className="gap-1 h-5 text-[10px] px-1.5">
          {getAgentDisplayName(filters.agentKey)}
          <button onClick={() => onRemoveFilter('agentKey')} className="ml-0.5 hover:text-foreground">
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      )}
      <Button variant="ghost" size="sm" onClick={onClearAll} className="text-[10px] h-5 px-1.5">
        Clear
      </Button>
    </div>
  );
};

// ==================== Status Icon ====================

const StatusIcon: React.FC<{ row: Pick<RunRow, 'failed' | 'passed'> }> = ({ row }) => {
  const allPassed = row.failed === 0 && row.passed > 0;
  if (allPassed) return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />;
  if (row.failed > 0) return <XCircle className="h-3 w-3 text-red-500 shrink-0" />;
  return <Clock className="h-3 w-3 text-muted-foreground shrink-0" />;
};

// ==================== Truncate-with-tooltip ====================

const TruncText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className={`truncate inline-block max-w-full align-bottom ${className || ''}`}>
        {text}
      </span>
    </TooltipTrigger>
    <TooltipContent>{text}</TooltipContent>
  </Tooltip>
);

// ==================== Mini pass-rate bar ====================

const RateBar: React.FC<{ rate: number; passed: number; failed: number; total: number }> = ({
  rate, passed, failed, total,
}) => {
  const pct = Math.round(rate * 100);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 w-full">
          <div className="h-1 flex-1 rounded-full overflow-hidden bg-muted/60 min-w-[24px]">
            <div
              className={`h-full ${rateColor(rate)} transition-[width]`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-7 text-right">
            {pct}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="text-emerald-400">{passed} passed</span>
        {' · '}
        <span className="text-red-400">{failed} failed</span>
        {' · '}
        <span>{total} total</span>
      </TooltipContent>
    </Tooltip>
  );
};

// ==================== Compact Run Row (widget) ====================

interface WidgetRowProps {
  row: RunRow;
  onClick: () => void;
  trailing?: React.ReactNode;
}

const WidgetRow: React.FC<WidgetRowProps> = ({ row, onClick, trailing }) => (
  <button
    onClick={onClick}
    className="group w-full grid items-center gap-2 px-3 h-8 text-left text-[11px] border-b last:border-b-0 hover:bg-muted/50 transition-colors"
    style={{ gridTemplateColumns: '12px minmax(0,1fr) auto 56px' }}
  >
    <StatusIcon row={row} />
    <div className="min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="truncate">
            <span className="font-medium">{row.run.name}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{row.benchmarkName}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-[11px]">
            <div className="font-medium">{row.run.name}</div>
            <div className="text-muted-foreground">{row.benchmarkName} · {row.agentName}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
    {trailing}
    <RateBarMini rate={row.passRate} />
  </button>
);

const RateBarMini: React.FC<{ rate: number }> = ({ rate }) => {
  const pct = Math.round(rate * 100);
  return (
    <div className="flex items-center gap-1 w-full">
      <div className="h-0.5 flex-1 rounded-full overflow-hidden bg-muted/60">
        <div className={`h-full ${rateColor(rate)}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] tabular-nums text-muted-foreground tracking-tight w-6 text-right">
        {pct}%
      </span>
    </div>
  );
};

// ==================== Recent Run Row (table) ====================

interface RecentRowProps {
  row: RunRow;
  onClick: () => void;
}

const RecentRow: React.FC<RecentRowProps> = ({ row, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="group w-full grid items-center gap-3 px-3 h-6 text-left text-[11px] border-b last:border-b-0 hover:bg-muted/50 transition-colors"
      style={{ gridTemplateColumns: '14px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 130px 80px 14px' }}
    >
      <StatusIcon row={row} />
      <div className="min-w-0">
        <TruncText text={row.run.name} className="text-[11px] font-medium" />
        <span className="text-muted-foreground"> · </span>
        <TruncText text={row.benchmarkName} className="text-[10px] text-muted-foreground" />
      </div>
      <TruncText text={row.agentName} className="text-[11px]" />
      <TruncText text={getModelName(row.run.modelId)} className="text-[11px] text-muted-foreground" />
      <RateBar rate={row.passRate} passed={row.passed} failed={row.failed} total={row.total} />
      <span className="text-[10px] text-muted-foreground whitespace-nowrap text-right tabular-nums">
        {formatRelativeTime(row.run.createdAt)}
      </span>
      <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
    </button>
  );
};

// Header row for the recent runs table
const RecentHeader: React.FC = () => (
  <div
    className="grid items-center gap-3 px-3 h-5 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/20"
    style={{ gridTemplateColumns: '14px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 130px 80px 14px' }}
  >
    <span />
    <span>Run · Benchmark</span>
    <span>Agent</span>
    <span>Model</span>
    <span>Pass rate</span>
    <span className="text-right">Time</span>
    <span />
  </div>
);

// ==================== Needs Improvement Widget ====================

interface NeedsImprovementWidgetProps {
  failingRows: RunRow[];
  regressions: RegressionRow[];
  onRowClick: (row: RunRow) => void;
}

const NeedsImprovementWidget: React.FC<NeedsImprovementWidgetProps> = ({
  failingRows, regressions, onRowClick,
}) => {
  const navigate = useNavigate();
  const initialTab = failingRows.length > 0 ? 'failing' : 'regressions';
  const empty = failingRows.length === 0 && regressions.length === 0;

  return (
    <Card className="flex flex-col overflow-hidden" data-testid="needs-improvement-card">
      <CardHeader className="pb-2 px-4 pt-3 space-y-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Needs Improvement
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-[10px] h-6 px-1.5 -mr-1.5"
            onClick={() => navigate('/evaluations/runs')}
          >
            All <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
        <CardDescription className="text-[11px] leading-tight">
          Where to focus to improve agent quality fastest.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-0 pt-0 pb-0 flex-1 min-h-0 flex flex-col">
        {empty ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-6">
            <CheckCircle2 className="h-6 w-6 text-emerald-500 mb-1.5 opacity-70" />
            <p className="text-[11px] text-muted-foreground text-center">
              No failing runs and no regressions detected.
            </p>
          </div>
        ) : (
          <Tabs defaultValue={initialTab} className="flex-1 min-h-0 flex flex-col">
            <TabsList className="mx-3 h-7 p-0.5 self-start">
              <TabsTrigger value="failing" className="h-6 px-2 text-[11px] gap-1">
                Failing
                <Badge variant="secondary" className="h-4 px-1 text-[9px] tabular-nums">
                  {failingRows.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="regressions" className="h-6 px-2 text-[11px] gap-1">
                Regressions
                <Badge variant="secondary" className="h-4 px-1 text-[9px] tabular-nums">
                  {regressions.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="failing" className="mt-2 flex-1 min-h-0">
              {failingRows.length === 0 ? (
                <p className="px-4 py-4 text-center text-[11px] text-muted-foreground">
                  No failing runs.
                </p>
              ) : (
                <ScrollArea className="h-full border-t">
                  {failingRows.map(r => (
                    <WidgetRow
                      key={`fail-${r.benchmarkId}-${r.run.id}`}
                      row={r}
                      onClick={() => onRowClick(r)}
                      trailing={
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4 py-0 px-1.5 border-red-500/40 text-red-600 dark:text-red-400 leading-none"
                        >
                          {r.failed} failing
                        </Badge>
                      }
                    />
                  ))}
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value="regressions" className="mt-2 flex-1 min-h-0">
              {regressions.length === 0 ? (
                <p className="px-4 py-4 text-center text-[11px] text-muted-foreground">
                  No regressions vs prior runs.
                </p>
              ) : (
                <ScrollArea className="h-full border-t">
                  {regressions.map(r => (
                    <WidgetRow
                      key={`reg-${r.benchmarkId}-${r.run.id}`}
                      row={r}
                      onClick={() => onRowClick(r)}
                      trailing={
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4 py-0 px-1.5 border-red-500/40 text-red-600 dark:text-red-400 gap-0.5 leading-none"
                        >
                          <TrendingDown className="h-2.5 w-2.5" />
                          {Math.round(r.delta * 100)}pp
                        </Badge>
                      }
                    />
                  ))}
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
};

// ==================== Main Dashboard ====================

export const Dashboard: React.FC = () => {
  const { dataState, isLoading: isCheckingData } = useDataState();
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(true);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [metricsMap, setMetricsMap] = useState<Map<string, { costUsd: number; durationMs: number; tokens: number }>>(new Map());
  const [testCaseCount, setTestCaseCount] = useState<number | null>(null);

  const isSampleMode = isSampleDataActive();

  const [filters, setFilters] = usePersistedState<DashboardFilter>('dashboard:filters', {});
  const [timeRange, setTimeRange] = usePersistedState<TimeRange>('dashboard:timeRange', '7d');
  const [selectedMetric, setSelectedMetric] = usePersistedState<TrendMetric>('dashboard:selectedMetric', 'passRate');

  // Test case count
  useEffect(() => {
    let cancelled = false;
    asyncTestCaseStorage.getAll()
      .then(tc => { if (!cancelled) setTestCaseCount(tc.length); })
      .catch(() => { if (!cancelled) setTestCaseCount(0); });
    return () => { cancelled = true; };
  }, []);

  // Phase 1: Benchmarks + reports
  useEffect(() => {
    if (isCheckingData || !dataState.hasData) return;
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const [allBenchmarks, allReports] = await Promise.all([
          asyncBenchmarkStorage.getAll(),
          asyncRunStorage.getAllReports({
            sortBy: 'timestamp',
            order: 'desc',
            limit: 500,
            fields: [
              'id', 'runId', 'experimentId', 'experimentRunId', 'testCaseId',
              'passFailStatus', 'accuracy', 'timestamp', 'agentConfig',
            ],
          }),
        ]);
        if (cancelled) return;
        setBenchmarks(allBenchmarks);
        setReports(allReports);
      } catch (err) {
        console.error('[Dashboard] Failed to load:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isCheckingData, dataState.hasData]);

  // Phase 2: deferred metrics
  useEffect(() => {
    const runIds = reports.filter(r => r.runId).map(r => r.runId!).slice(0, 100);
    if (runIds.length === 0) return;
    fetchBatchMetrics(runIds)
      .then(({ metrics }) => {
        const m = new Map<string, { costUsd: number; durationMs: number; tokens: number }>();
        for (const x of metrics) {
          m.set(x.runId, { costUsd: x.costUsd, durationMs: x.durationMs, tokens: x.totalTokens });
        }
        setMetricsMap(m);
      })
      .catch(err => console.warn('[Dashboard] Metrics load failed:', err));
  }, [reports]);

  const trendData = useMemo<TrendDataPoint[]>(
    () => aggregateMetricsByDate(benchmarks, reports, metricsMap, filters, timeRange),
    [benchmarks, reports, metricsMap, filters, timeRange],
  );
  const agents = useMemo(() => getUniqueAgents(benchmarks), [benchmarks]);

  const allRows = useMemo(() => buildRunRows(benchmarks), [benchmarks]);
  const totalRuns = allRows.length;

  const failingRows = useMemo<RunRow[]>(
    () =>
      allRows
        .filter(r => r.failed > 0)
        .sort((a, b) => {
          if (b.failed !== a.failed) return b.failed - a.failed;
          return new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime();
        })
        .slice(0, 20),
    [allRows],
  );

  const regressions = useMemo<RegressionRow[]>(() => {
    const groups = new Map<string, RunRow[]>();
    for (const r of allRows) {
      const key = `${r.benchmarkId}::${r.run.agentKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const out: RegressionRow[] = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const sorted = [...rows].sort(
        (a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime(),
      );
      const latest = sorted[0];
      const prev = sorted[1];
      if (latest.passRate < prev.passRate) {
        out.push({ ...latest, prevPassRate: prev.passRate, delta: latest.passRate - prev.passRate });
      }
    }
    return out.sort((a, b) => a.delta - b.delta).slice(0, 20);
  }, [allRows]);

  const recentRows = useMemo<RunRow[]>(
    () =>
      [...allRows]
        .sort((a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime())
        .slice(0, 15),
    [allRows],
  );

  const goToRun = (row: RunRow) =>
    navigate(`/evaluations/benchmarks/${row.benchmarkId}/runs/${row.run.id}/inspect`);

  const handleRemoveFilter = (type: 'benchmarkId' | 'agentKey') =>
    setFilters(prev => ({ ...prev, [type]: undefined }));
  const handleClearAllFilters = () => setFilters({});

  const hasData = benchmarks.length > 0 && benchmarks.some(b => b.runs && b.runs.length > 0);

  if (isCheckingData) {
    return (
      <div className="p-5 max-w-7xl mx-auto space-y-4" data-testid="dashboard-page">
        <div>
          <h2 className="text-xl font-bold" data-testid="dashboard-title">Leaderboard Overview</h2>
          <p className="text-[12px] text-muted-foreground">
            Track performance trends and surface runs that need improvement
          </p>
        </div>
        <DashboardSkeleton />
      </div>
    );
  }

  if (!dataState.hasData) {
    return <FirstRunExperience showCodingAgentsBanner={false} />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-5 max-w-7xl mx-auto space-y-4" data-testid="dashboard-page">
        {isSampleMode && (
          <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800 py-2">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <AlertTitle className="text-blue-900 dark:text-blue-100 text-[13px]">
              You're viewing sample data
            </AlertTitle>
            <AlertDescription className="text-blue-800 dark:text-blue-200 text-[12px]">
              This is demonstration data to help you explore Agent Health.{' '}
              <Link
                to="/settings/clusters"
                className="underline font-medium hover:text-blue-600 dark:hover:text-blue-300"
              >
                Connect your own data
              </Link>{' '}
              to start tracking your agents.
            </AlertDescription>
          </Alert>
        )}

        {/* Header row */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold leading-tight" data-testid="dashboard-title">
              Leaderboard Overview
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Track performance trends and surface runs that need improvement
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="stats-summary-bar">
            <StatPill
              to="/evaluations/benchmarks"
              icon={BarChart3}
              label="Benchmarks"
              value={benchmarks.length}
              testId="stats-benchmarks"
            />
            <StatPill
              to="/evaluations/runs"
              icon={Play}
              label="Runs"
              value={totalRuns.toLocaleString()}
              testId="stats-runs"
            />
            <StatPill
              to="/evaluations/test-cases"
              icon={FileText}
              label="Test Cases"
              value={testCaseCount === null ? '—' : testCaseCount}
              testId="stats-test-cases"
            />
          </div>
        </div>

        {isLoading ? (
          <DashboardSkeleton />
        ) : !hasData ? (
          <Card>
            <CardContent className="py-8 text-center space-y-2">
              <p className="text-[12px] text-muted-foreground">
                You have benchmarks but no runs yet. Kick off a run to start tracking agent health.
              </p>
              <Button asChild size="sm">
                <Link to="/evaluations/benchmarks">Go to Benchmarks</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Trends + Needs Improvement: 2/3 + 1/3 */}
            <div className="grid gap-4 lg:grid-cols-3 lg:auto-rows-[340px]">
              {/* Performance Trends — 2/3 */}
              <Card className="lg:col-span-2 flex flex-col overflow-hidden">
                <CardHeader className="pb-2 px-4 pt-3 space-y-1">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm">Performance Trends</CardTitle>
                      <CardDescription className="text-[11px] leading-tight">
                        {agents.length > 0
                          ? `${agents.length} agent${agents.length > 1 ? 's' : ''} · ${benchmarks.length} benchmark${benchmarks.length > 1 ? 's' : ''}`
                          : 'Agent performance over time'}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Select value={selectedMetric} onValueChange={v => setSelectedMetric(v as TrendMetric)}>
                        <SelectTrigger className="h-7 w-[110px] text-[11px]">
                          <SelectValue placeholder="Metric" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="passRate">Pass Rate</SelectItem>
                          <SelectItem value="cost">Cost</SelectItem>
                          <SelectItem value="tokens">Tokens</SelectItem>
                          <SelectItem value="latency">Latency</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={timeRange} onValueChange={v => setTimeRange(v as TimeRange)}>
                        <SelectTrigger className="h-7 w-[105px] text-[11px]">
                          <SelectValue placeholder="Range" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="7d">Last 7 days</SelectItem>
                          <SelectItem value="30d">Last 30 days</SelectItem>
                          <SelectItem value="all">All time</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <FilterChips
                    filters={filters}
                    benchmarks={benchmarks}
                    onRemoveFilter={handleRemoveFilter}
                    onClearAll={handleClearAllFilters}
                  />
                </CardHeader>
                <CardContent className="flex-1 min-h-0 px-2 pb-2 pt-0">
                  <div className="h-full w-full">
                    <AgentTrendChart data={trendData} metric={selectedMetric} />
                  </div>
                </CardContent>
              </Card>

              {/* Needs Improvement — 1/3 */}
              <NeedsImprovementWidget
                failingRows={failingRows}
                regressions={regressions}
                onRowClick={goToRun}
              />
            </div>

            {/* Recent Evaluation Runs — full width */}
            <Card data-testid="recent-runs-card">
              <CardHeader className="pb-2 px-4 pt-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      Recent Evaluation Runs
                    </CardTitle>
                    <CardDescription className="text-[11px] leading-tight">
                      Latest {recentRows.length} run{recentRows.length === 1 ? '' : 's'}. Click a row to inspect.
                    </CardDescription>
                  </div>
                  <Button asChild variant="ghost" size="sm" className="gap-1 text-[11px] h-7 -mr-1.5">
                    <Link to="/evaluations/runs">View all <ArrowRight className="h-3 w-3" /></Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="px-0 pt-0 pb-0">
                <RecentHeader />
                {recentRows.map(r => (
                  <RecentRow
                    key={`recent-${r.benchmarkId}-${r.run.id}`}
                    row={r}
                    onClick={() => goToRun(r)}
                  />
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TooltipProvider>
  );
};
