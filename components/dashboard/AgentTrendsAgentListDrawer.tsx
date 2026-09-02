/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendsAgentListDrawer
 *
 * Replaces v2's AgentTrendsLegendDrawer (a checkbox-per-agent hide/show
 * legend for the all-agents overlay chart, which v3 no longer has). This
 * is now the secondary "all agents, over time" view — the primary
 * visualization is the ranked dot plot (AgentBenchmarkDotPlot) for one
 * benchmark's latest snapshot; this bottom drawer lists EVERY agent
 * across the current benchmark/time scope as an `AgentTrendRow` (name +
 * sparkline-over-time + latest value + Δ), with a name filter for large
 * agent counts. Clicking a row opens that agent's latest run report and
 * closes the drawer.
 *
 * Built on the existing `Sheet` primitive (side="bottom", non-modal — same
 * pattern as AgentTracesPage's span-details drawer) rather than a
 * trigger-anchored popover: at narrow viewports an anchored popover can be
 * positioned off-screen depending on where the trigger lands in a
 * flex-wrapped header, whereas a bottom sheet is always `inset-x-0` (full
 * viewport width) regardless of viewport size or trigger position.
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { AgentTrendRow as AgentTrendRowData, TrendMetricKey } from '@/lib/agentTrends';
import { AgentTrendRow } from '@/components/dashboard/AgentTrendRow';

export interface AgentTrendsAgentListDrawerProps {
  rows: AgentTrendRowData[];
  metric: TrendMetricKey;
  onSelectAgent: (agentKey: string) => void;
}

export const AgentTrendsAgentListDrawer: React.FC<AgentTrendsAgentListDrawerProps> = ({
  rows, metric, onSelectAgent,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.agentName.toLowerCase().includes(q));
  }, [rows, query]);

  if (rows.length === 0) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="agent-trends-agents-toggle"
          className="text-[11px] px-2.5 py-1 rounded-md bg-muted/60 text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
        >
          History ({rows.length} agents)
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        data-testid="agent-trends-agents-menu"
        aria-label="All agents, over time"
        className="h-[min(70vh,480px)] p-0 flex flex-col"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close agents drawer"
          title="Close (Esc)"
          className="absolute top-2 right-2 h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted z-10"
        >
          <X size={14} />
        </button>
        <div className="px-4 pt-4 pb-2 shrink-0 space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            All {rows.length} agents, over time — click a row to open its latest run report
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter agents by name…"
              data-testid="agent-trends-agents-filter"
              className="w-full h-7 pl-7 pr-2 text-[11px] rounded-md border bg-background"
            />
          </div>
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-3">
          {filteredRows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">No agents match &ldquo;{query}&rdquo;.</p>
          ) : (
            filteredRows.map(row => (
              <AgentTrendRow
                key={row.agentKey}
                row={row}
                metric={metric}
                onSelect={(agentKey) => { onSelectAgent(agentKey); setOpen(false); }}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
