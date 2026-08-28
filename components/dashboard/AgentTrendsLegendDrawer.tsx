/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTrendsLegendDrawer
 *
 * Replaces the always-visible per-agent chips ROW in the Agent Trends band
 * with a single "Agents (N)" trigger that opens a bottom drawer — color
 * swatch, name, latest accuracy + WoW delta, cost/run, tokens/run (the same
 * fields the old chips showed, computed by the same
 * `computeAgentChipSummaries`) — plus a per-agent visibility checkbox that
 * hides/shows that agent's line+dots on the chart (standard legend
 * semantics).
 *
 * Built on the existing `Sheet` primitive (side="bottom", non-modal — same
 * pattern as AgentTracesPage's span-details drawer) rather than a
 * trigger-anchored popover: at narrow viewports an anchored popover can be
 * positioned off-screen depending on where the trigger lands in a
 * flex-wrapped header, whereas a bottom sheet is always `inset-x-0` (full
 * viewport width) regardless of viewport size or trigger position.
 */

import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Minus, ChevronDown, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCost, formatTokens } from '@/services/metrics';
import { AgentChipSummary } from '@/lib/agentTrends';

export interface AgentTrendsLegendDrawerProps {
  chips: AgentChipSummary[];
  colorMap: Map<string, string>;
  hiddenAgentKeys: Set<string>;
  onToggleAgent: (agentKey: string) => void;
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
        <Minus className="h-3 w-3" /> n/a
      </span>
    );
  }
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded) < 0.05) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
        <Minus className="h-3 w-3" /> 0pp
      </span>
    );
  }
  const isUp = rounded > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {isUp ? '+' : ''}{rounded}pp
    </span>
  );
}

export const AgentTrendsLegendDrawer: React.FC<AgentTrendsLegendDrawerProps> = ({
  chips, colorMap, hiddenAgentKeys, onToggleAgent,
}) => {
  const [open, setOpen] = useState(false);

  if (chips.length === 0) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="agent-trends-agents-toggle"
          className="text-[11px] px-2.5 py-1 rounded-md bg-muted/60 text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
        >
          Agents ({chips.length})
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        data-testid="agent-trends-agents-menu"
        aria-label="Agents in scope"
        className="h-[min(60vh,420px)] p-0 flex flex-col"
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
        <div className="text-[11px] font-medium text-muted-foreground px-4 pt-4 pb-1.5 shrink-0">
          Agents in scope — uncheck to hide from chart
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto px-3 pb-3">
          {chips.map(chip => {
            const visible = !hiddenAgentKeys.has(chip.agentKey);
            return (
              <label
                key={chip.agentKey}
                className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-muted/40 cursor-pointer"
                data-testid={`agent-trends-agents-menu-row-${chip.agentKey}`}
              >
                <Checkbox
                  checked={visible}
                  onCheckedChange={() => onToggleAgent(chip.agentKey)}
                  data-testid={`agent-trends-agent-visibility-${chip.agentKey}`}
                  className="mt-0.5"
                  aria-label={`Toggle ${chip.agentName} visibility`}
                />
                <span
                  className="mt-1 h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: colorMap.get(chip.agentKey) }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 text-[11px]">
                  <div className="font-medium truncate">{chip.agentName}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="font-semibold tabular-nums">
                      {chip.latestAccuracyPct != null ? `${chip.latestAccuracyPct.toFixed(1)}%` : '—'}
                    </span>
                    <DeltaBadge value={chip.wowDeltaPct} />
                  </div>
                  <div className="text-muted-foreground mt-0.5">
                    {chip.latestCostUsd != null ? formatCost(chip.latestCostUsd) : '—'}/run
                    {' · '}
                    {chip.latestTokens != null ? formatTokens(chip.latestTokens) : '—'} tok
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
};
