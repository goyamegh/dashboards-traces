/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFlyoutContent - Detailed trace view shown in flyout panel
 *
 * Displays trace visualization with:
 * - Trace overview with metrics
 * - Timeline/Flow view of spans
 * - Span details panel with input/output from OTEL conventions
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Maximize2,
  Hash,
  Server,
  Cpu,
  MessageSquare,
  Wrench,
  Bot,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Span, TimeRange } from '@/types';
import { processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from './TraceVisualization';
import ViewToggle, { ViewMode } from './ViewToggle';
import TraceFullScreenView from './TraceFullScreenView';
import { SpanInputOutput } from './SpanInputOutput';

interface TraceTableRow {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTime: Date;
  duration: number;
  spanCount: number;
  hasErrors: boolean;
  spans: Span[];
}

interface TraceFlyoutContentProps {
  trace: TraceTableRow;
  onClose: () => void;
}

export const TraceFlyoutContent: React.FC<TraceFlyoutContentProps> = ({
  trace,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState('traces');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copiedTraceId, setCopiedTraceId] = useState(false);

  // Process spans into tree
  const spanTree = useMemo(() => processSpansIntoTree(trace.spans), [trace.spans]);
  const timeRange = useMemo(() => calculateTimeRange(trace.spans), [trace.spans]);

  // Auto-expand root spans
  useEffect(() => {
    const rootIds = new Set(spanTree.map(s => s.spanId));
    setExpandedSpans(rootIds);
  }, [spanTree]);

  // Handle expand toggle
  const handleToggleExpand = (spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  // Copy trace ID to clipboard
  const handleCopyTraceId = async () => {
    try {
      await navigator.clipboard.writeText(trace.traceId);
      setCopiedTraceId(true);
      setTimeout(() => setCopiedTraceId(false), 2000);
    } catch (err) {
      console.error('Failed to copy trace ID to clipboard:', err);
    }
  };

  // Calculate span stats
  const spanStats = useMemo(() => {
    const byStatus = trace.spans.reduce(
      (acc, span) => {
        if (span.status === 'ERROR') acc.error++;
        else if (span.status === 'OK') acc.ok++;
        else acc.unset++;
        return acc;
      },
      { ok: 0, error: 0, unset: 0 }
    );

    // Count by category based on span attributes
    const byCategory = trace.spans.reduce(
      (acc, span) => {
        const name = span.name.toLowerCase();
        if (name.includes('llm') || name.includes('bedrock') || name.includes('converse')) {
          acc.llm++;
        } else if (name.includes('tool') || span.attributes?.['gen_ai.tool.name']) {
          acc.tool++;
        } else if (name.includes('agent')) {
          acc.agent++;
        } else {
          acc.other++;
        }
        return acc;
      },
      { agent: 0, llm: 0, tool: 0, other: 0 }
    );

    return { byStatus, byCategory };
  }, [trace.spans]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b bg-card">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {trace.hasErrors ? (
                <XCircle size={18} className="text-red-400" />
              ) : (
                <CheckCircle2 size={18} className="text-green-400" />
              )}
              <h2 className="text-lg font-semibold truncate">{trace.rootSpanName}</h2>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono flex items-center gap-1">
                <Hash size={12} />
                {trace.traceId.slice(0, 16)}...
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleCopyTraceId}
                title="Copy trace ID"
              >
                {copiedTraceId ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
              </Button>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-4 gap-3">
          <Card className="bg-muted/50">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1">Duration</div>
              <div className="text-sm font-semibold text-amber-400">
                {formatDuration(trace.duration)}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/50">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1">Spans</div>
              <div className="text-sm font-semibold text-purple-400">
                {trace.spanCount}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/50">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1">Service</div>
              <div className="text-sm font-semibold truncate" title={trace.serviceName}>
                {trace.serviceName}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/50">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1">Start Time</div>
              <div className="text-sm font-semibold">
                {trace.startTime.toLocaleTimeString()}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Span Stats */}
        <div className="flex items-center gap-4 mt-3 text-xs">
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground">Status:</span>
            <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/30">
              OK: {spanStats.byStatus.ok}
            </Badge>
            {spanStats.byStatus.error > 0 && (
              <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30">
                Error: {spanStats.byStatus.error}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground">Categories:</span>
            {spanStats.byCategory.agent > 0 && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/30">
                <Bot size={10} className="mr-1" />
                Agent: {spanStats.byCategory.agent}
              </Badge>
            )}
            {spanStats.byCategory.llm > 0 && (
              <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30">
                <Cpu size={10} className="mr-1" />
                LLM: {spanStats.byCategory.llm}
              </Badge>
            )}
            {spanStats.byCategory.tool > 0 && (
              <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30">
                <Wrench size={10} className="mr-1" />
                Tool: {spanStats.byCategory.tool}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
          <TabsTrigger
            value="traces"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
          >
            <Activity size={14} className="mr-2" />
            Traces
            <Badge variant="secondary" className="ml-2">{trace.spanCount}</Badge>
          </TabsTrigger>
          <TabsTrigger
            value="details"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
          >
            <MessageSquare size={14} className="mr-2" />
            Input/Output
          </TabsTrigger>
        </TabsList>

        {/* Traces Tab */}
        <TabsContent value="traces" className="flex-1 mt-0 overflow-hidden flex flex-col">
          {/* View Toggle & Fullscreen */}
          <div className="flex items-center justify-between p-3 border-b">
            <ViewToggle viewMode={viewMode} onChange={setViewMode} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFullscreenOpen(true)}
              className="gap-1.5"
            >
              <Maximize2 size={14} />
              Fullscreen
            </Button>
          </div>

          {/* Trace Visualization */}
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
              showSpanDetailsPanel={true}
            />
          </div>
        </TabsContent>

        {/* Input/Output Tab */}
        <TabsContent value="details" className="flex-1 mt-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              <SpanInputOutput spans={trace.spans} />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Fullscreen View */}
      <TraceFullScreenView
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        title={trace.rootSpanName}
        subtitle={`Trace ID: ${trace.traceId.slice(0, 16)}...`}
        spanTree={spanTree}
        timeRange={timeRange}
        selectedSpan={selectedSpan}
        onSelectSpan={setSelectedSpan}
        initialViewMode={viewMode}
        onViewModeChange={setViewMode}
        spanCount={trace.spanCount}
      />
    </div>
  );
};

export default TraceFlyoutContent;
