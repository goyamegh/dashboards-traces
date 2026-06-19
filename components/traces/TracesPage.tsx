/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TracesPage - Live Trace Tailing
 *
 * Live monitoring page showing traces from the last 5 minutes
 * with agent filter and text search. Supports Flow and Timeline views.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, RefreshCw, Activity, Pause, Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Span } from '@/types';
import {
  fetchRecentTraces,
  processSpansIntoTree,
  calculateTimeRange,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import { startMeasure, endMeasure } from '@/lib/performance';
import TraceVisualization from './TraceVisualization';
import ViewToggle, { ViewMode } from './ViewToggle';

const REFRESH_INTERVAL_MS = 30000; // 30 seconds - reduces API calls by 67%

export const TracesPage: React.FC = () => {
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('agent-map');

  // Filter state
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [minutesAgo, setMinutesAgo] = useState<number>(60);
  // OTel service.names actually seen in fetched spans, accumulated across fetches
  // so the Service filter reflects real data — not agent display names (which never
  // match service.name, e.g. "Claude Code" vs "claude-code-agent").
  const [knownServices, setKnownServices] = useState<string[]>([]);
  const [textSearch, setTextSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Tailing state
  const [isTailing, setIsTailing] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Pagination state
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Trace data
  const [spans, setSpans] = useState<Span[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Service filter options derived from the OTel `service.name`s actually present
  // in fetched spans (accumulated in knownServices). Fixes the prior bug where
  // options came from agent display names (e.g. "Claude Code") which never match
  // the emitted service.name (e.g. "claude-code-agent"), so filtering showed nothing.
  const agentOptions = [
    { value: 'all', label: 'All Services' },
    ...knownServices.map(n => ({ value: n, label: n })),
  ];

  // Live-window options (minutes). Default 60m so recent runs — including
  // claude-code spans that lag ~5min through the OSI ingestion pipeline — appear.
  const RANGE_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 5, label: 'Last 5 min' },
    { value: 15, label: 'Last 15 min' },
    { value: 60, label: 'Last 1 hour' },
    { value: 360, label: 'Last 6 hours' },
    { value: 1440, label: 'Last 24 hours' },
    { value: 10080, label: 'Last 7 days' },
  ];

  // Process spans into tree
  const spanTree = useMemo(() => {
    startMeasure('TracesPage.processTree');
    const tree = processSpansIntoTree(spans);
    endMeasure('TracesPage.processTree');
    return tree;
  }, [spans]);

  const timeRange = useMemo(() => {
    startMeasure('TracesPage.calculateTimeRange');
    const range = calculateTimeRange(spans);
    endMeasure('TracesPage.calculateTimeRange');
    return range;
  }, [spans]);

  // Debounce text search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(textSearch);
    }, 500);
    return () => clearTimeout(timer);
  }, [textSearch]);

  // Fetch traces (with optional pagination)
  const fetchTraces = useCallback(async (loadMore = false) => {
    const operationName = loadMore ? 'TracesPage.fetchMore' : 'TracesPage.fetchTraces';
    startMeasure(operationName);

    if (loadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setCursor(null); // Reset cursor on fresh fetch
    }
    setError(null);

    try {
      startMeasure('TracesPage.apiCall');
      const result = await fetchRecentTraces({
        minutesAgo,
        serviceName: selectedAgent !== 'all' ? selectedAgent : undefined,
        textSearch: debouncedSearch || undefined,
        size: 100, // Reduced from 500 to 100 for pagination
        cursor: loadMore ? cursor || undefined : undefined,
      });
      endMeasure('TracesPage.apiCall');

      // Accumulate distinct OTel service.names for the Service filter dropdown.
      const seenServices = result.spans
        .map(s => (s.attributes as Record<string, unknown> | undefined)?.['service.name'])
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (seenServices.length > 0) {
        setKnownServices(prev => Array.from(new Set([...prev, ...seenServices])).sort());
      }

      startMeasure('TracesPage.updateState');
      if (loadMore) {
        // Append to existing spans
        setSpans(prev => [...prev, ...result.spans]);
      } else {
        // Replace spans
        setSpans(result.spans);
        setLastRefresh(new Date());
      }

      // Update pagination state
      setCursor(result.nextCursor || null);
      setHasMore(result.hasMore || false);

      // Auto-expand root spans (for Timeline view)
      // Identify roots by checking which spans have no parent in the result set
      if (result.spans.length > 0 && !loadMore) {
        const spanIds = new Set(result.spans.map(s => s.spanId));
        const rootIds = new Set(
          result.spans
            .filter(s => !s.parentSpanId || !spanIds.has(s.parentSpanId))
            .map(s => s.spanId)
        );
        setExpandedSpans(prev => {
          const newSet = new Set(prev);
          rootIds.forEach(id => newSet.add(id));
          return newSet;
        });
      }
      endMeasure('TracesPage.updateState');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      endMeasure(operationName);
    }
  }, [selectedAgent, minutesAgo, debouncedSearch, cursor]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchTraces();

    if (isTailing) {
      refreshIntervalRef.current = setInterval(fetchTraces, REFRESH_INTERVAL_MS);
    }

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [fetchTraces, isTailing]);

  // Pause auto-refresh when tab is hidden to reduce unnecessary API calls
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Pause when tab is hidden
        if (refreshIntervalRef.current) {
          clearInterval(refreshIntervalRef.current);
          refreshIntervalRef.current = null;
        }
      } else if (isTailing && !refreshIntervalRef.current) {
        // Resume when tab becomes visible
        fetchTraces(); // Immediate refresh
        refreshIntervalRef.current = setInterval(fetchTraces, REFRESH_INTERVAL_MS);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isTailing, fetchTraces]);

  // Toggle expand handler (for Timeline view)
  const handleToggleExpand = useCallback((spanId: string) => {
    setExpandedSpans(prev => {
      const newSet = new Set(prev);
      if (newSet.has(spanId)) {
        newSet.delete(spanId);
      } else {
        newSet.add(spanId);
      }
      return newSet;
    });
  }, []);

  // Toggle tailing
  const toggleTailing = () => {
    setIsTailing(prev => !prev);
  };

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Live Traces</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Real-time trace monitoring · {(RANGE_OPTIONS.find(r => r.value === minutesAgo)?.label ?? `last ${minutesAgo} min`).toLowerCase()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle viewMode={viewMode} onChange={setViewMode} />
          {lastRefresh && (
            <span className="text-xs text-muted-foreground">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant={isTailing ? "default" : "outline"}
            size="sm"
            onClick={toggleTailing}
            className={isTailing ? "bg-green-600 hover:bg-green-700" : ""}
          >
            {isTailing ? (
              <>
                <Pause size={14} className="mr-1.5" />
                Tailing
              </>
            ) : (
              <>
                <Play size={14} className="mr-1.5" />
                Paused
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchTraces(false)}
            disabled={isLoading}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex gap-4 items-end">
            {/* Time Range */}
            <div className="w-40 space-y-1.5">
              <label className="text-xs text-muted-foreground">Time range</label>
              <Select value={String(minutesAgo)} onValueChange={(v) => setMinutesAgo(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Service Filter */}
            <div className="w-48 space-y-1.5">
              <label className="text-xs text-muted-foreground">Service</label>
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Text Search */}
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">Search</label>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search span names, attributes..."
                  value={textSearch}
                  onChange={(e) => setTextSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-3 text-sm">
              <Badge variant="outline" className="font-mono">
                {spans.length} spans
              </Badge>
              {timeRange.duration > 0 && (
                <Badge variant="outline" className="font-mono">
                  {formatDuration(timeRange.duration)}
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error State */}
      {error && (
        <Card className="mb-4 bg-red-500/10 border-red-500/30">
          <CardContent className="p-4 text-sm text-red-400">
            {error}
          </CardContent>
        </Card>
      )}

      {/* Trace Visualization */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardHeader className="py-2 px-4 border-b">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} />
            {viewMode === 'flow' ? 'Trace Flow' : 'Trace Timeline'}
            {isTailing && (
              <span className="flex items-center gap-1 text-xs text-green-400 font-normal">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                Live
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-0 overflow-hidden flex flex-col">
          {spans.length === 0 && !isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Activity size={48} className="mb-4 opacity-20" />
              <p>No traces found in the last 5 minutes</p>
              <p className="text-sm mt-1">
                {selectedAgent !== 'all' || textSearch
                  ? 'Try adjusting your filters'
                  : 'Traces will appear here as agents execute'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-hidden">
                <TraceVisualization
                  spanTree={spanTree}
                  timeRange={timeRange}
                  initialViewMode={viewMode}
                  onViewModeChange={setViewMode}
                  showViewToggle={false}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                  expandedSpans={expandedSpans}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
              {/* Load More button */}
              {hasMore && (
                <div className="p-4 border-t flex justify-center">
                  <Button
                    variant="outline"
                    onClick={(e) => {
                      e.preventDefault();
                      fetchTraces(true);
                    }}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <RefreshCw size={14} className="mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      `Load More Spans`
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default TracesPage;
