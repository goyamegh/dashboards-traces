/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentSessionPanel
 *
 * Collapsible run-detail section answering "what did the agent HAVE, what
 * did it USE, and what was it DENIED?" from `report.agentSession` (see
 * `AgentSessionInfo` in types/index.ts). Renders nothing when the report
 * carries no session info (older runs, connectors that don't emit it).
 *
 * Deliberately presentational: no inference from the agent's config. Used
 * tools that are not in the allowed list are highlighted, as are permission
 * denials and errored tools, because those are the audit questions the
 * trajectory alone cannot answer.
 */

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, ShieldAlert, AlertTriangle } from 'lucide-react';
import type { AgentSessionInfo } from '@/types';
import { Badge } from '@/components/ui/badge';
import { formatCost, formatTokens } from '@/services/metrics';

interface AgentSessionPanelProps {
  session?: AgentSessionInfo;
  /** Whether the section starts open. Default: false (collapsed). */
  defaultOpen?: boolean;
}

const Chip: React.FC<{ children: React.ReactNode; tone?: 'default' | 'used' | 'warn' | 'error'; title?: string }> = ({
  children,
  tone = 'default',
  title,
}) => {
  const cls =
    tone === 'used'
      ? 'bg-opensearch-blue/15 text-opensearch-blue border-opensearch-blue/30'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
        : tone === 'error'
          ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
          : 'bg-muted text-muted-foreground border-border';
  return (
    <span title={title} className={`inline-block rounded border px-1.5 py-0 text-[10px] font-mono leading-4 ${cls}`}>
      {children}
    </span>
  );
};

const Row: React.FC<{ label: string; count?: number; children: React.ReactNode; testId?: string }> = ({
  label,
  count,
  children,
  testId,
}) => (
  <div className="flex gap-2 items-start" data-testid={testId}>
    <div className="w-28 shrink-0 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-0.5">
      {label}
      {count !== undefined && <span className="ml-1 font-normal normal-case">({count})</span>}
    </div>
    <div className="flex flex-wrap gap-1 min-w-0">{children}</div>
  </div>
);

const denialToolName = (d: Record<string, unknown>): string =>
  typeof d.tool_name === 'string' ? d.tool_name : typeof d.toolName === 'string' ? d.toolName : 'unknown tool';

export const AgentSessionPanel: React.FC<AgentSessionPanelProps> = ({ session, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  if (!session || Object.keys(session).length === 0) return null;

  const tools = session.tools ?? [];
  const toolsUsed = session.toolsUsed ?? [];
  const allowed = new Set(tools);
  const usedNotAllowed = tools.length > 0 ? toolsUsed.filter(t => !allowed.has(t)) : [];
  const skills = session.skills ?? [];
  const skillsInvoked = session.skillsInvoked ?? [];
  const invoked = new Set(skillsInvoked);
  const offered = new Set(skills);
  const invokedOffered = skillsInvoked.filter(s => offered.has(s)).length;
  const denials = session.permissionDenials ?? [];
  const toolErrors = session.toolErrors ?? [];
  const plugins = session.plugins ?? [];
  const mcp = session.mcpServers ?? [];
  const u = session.usage;
  const totalTokens =
    u && (u.inputTokens || u.outputTokens || u.cacheCreationInputTokens || u.cacheReadInputTokens)
      ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)
      : undefined;

  const headline = [session.agentVersion && `v${session.agentVersion}`, session.model, session.permissionMode]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border-b bg-muted/30 shrink-0" data-testid="agent-session-panel">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-1.5 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={open}
        data-testid="agent-session-toggle"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown size={12} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground shrink-0" />
          )}
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Agent session</span>
          {headline && (
            <span className="text-[10px] text-muted-foreground truncate" title={headline}>
              {headline}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {skills.length > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
              {invokedOffered}/{skills.length} skills
            </Badge>
          )}
          {toolsUsed.length > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
              {toolsUsed.length} tools used
            </Badge>
          )}
          {denials.length > 0 && (
            <Badge
              variant="destructive"
              className="text-[9px] px-1.5 py-0 gap-1"
              data-testid="agent-session-denials-badge"
            >
              <ShieldAlert size={9} /> {denials.length} denied
            </Badge>
          )}
          {usedNotAllowed.length > 0 && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400"
              data-testid="agent-session-unlisted-badge"
            >
              <AlertTriangle size={9} /> {usedNotAllowed.length} unlisted
            </Badge>
          )}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-2" data-testid="agent-session-body">
          {(session.numTurns !== undefined || session.totalCostUsd !== undefined || totalTokens !== undefined || session.durationApiMs !== undefined) && (
            <Row label="Run">
              {session.numTurns !== undefined && <Chip>{session.numTurns} turns</Chip>}
              {session.totalCostUsd !== undefined && <Chip>{formatCost(session.totalCostUsd)}</Chip>}
              {totalTokens !== undefined && (
                <Chip
                  title={`in ${u?.inputTokens ?? 0} · out ${u?.outputTokens ?? 0} · cache write ${u?.cacheCreationInputTokens ?? 0} · cache read ${u?.cacheReadInputTokens ?? 0}`}
                >
                  {formatTokens(totalTokens)} tokens
                </Chip>
              )}
              {session.durationApiMs !== undefined && <Chip>{(session.durationApiMs / 1000).toFixed(1)}s API</Chip>}
              {session.stopReason && <Chip tone={session.isError ? 'error' : 'default'}>{session.stopReason}</Chip>}
            </Row>
          )}

          {denials.length > 0 && (
            <Row label="Denied" count={denials.length} testId="agent-session-denials">
              {denials.map((d, i) => (
                <Chip key={i} tone="error" title={JSON.stringify(d)}>
                  {denialToolName(d)}
                </Chip>
              ))}
            </Row>
          )}

          {toolErrors.length > 0 && (
            <Row label="Tool errors" testId="agent-session-tool-errors">
              {toolErrors.map(e => (
                <Chip key={e.toolName} tone="warn" title={e.firstError ? `First error: ${e.firstError}` : 'Tool returned an error result (not necessarily a permission denial)'}>
                  {e.toolName} ×{e.count}
                </Chip>
              ))}
            </Row>
          )}

          {(toolsUsed.length > 0 || tools.length > 0) && (
            <Row label="Tools used" count={toolsUsed.length} testId="agent-session-tools-used">
              {toolsUsed.length === 0 && <span className="text-[10px] text-muted-foreground">none</span>}
              {toolsUsed.map(t => (
                <Chip key={t} tone={tools.length > 0 && !allowed.has(t) ? 'warn' : 'used'} title={tools.length > 0 && !allowed.has(t) ? 'Used but not in the allowed tools list' : undefined}>
                  {t}
                </Chip>
              ))}
            </Row>
          )}

          {tools.length > 0 && (
            <Row label="Tools allowed" count={tools.length} testId="agent-session-tools">
              {tools.map(t => (
                <Chip key={t}>{t}</Chip>
              ))}
            </Row>
          )}

          {skills.length > 0 && (
            <Row label="Skills" count={skills.length} testId="agent-session-skills">
              {skills.map(s => (
                <Chip key={s} tone={invoked.has(s) ? 'used' : 'default'} title={invoked.has(s) ? 'Invoked in this run' : 'Available, not invoked'}>
                  {s}
                </Chip>
              ))}
              {skillsInvoked.filter(s => !skills.includes(s)).map(s => (
                <Chip key={`inv-${s}`} tone="warn" title="Invoked but not in the available skills list">
                  {s}
                </Chip>
              ))}
            </Row>
          )}

          {plugins.length > 0 && (
            <Row label="Plugins" count={plugins.length} testId="agent-session-plugins">
              {plugins.map(p => (
                <Chip key={p.name} title={p.source}>
                  {p.name}
                </Chip>
              ))}
            </Row>
          )}

          {mcp.length > 0 && (
            <Row label="MCP servers" count={mcp.length} testId="agent-session-mcp">
              {mcp.map(m => (
                <Chip key={m.name} tone={m.status && m.status !== 'connected' ? 'warn' : 'default'}>
                  {m.name}
                  {m.status ? ` · ${m.status}` : ''}
                </Chip>
              ))}
            </Row>
          )}

          {(session.agents?.length ?? 0) > 0 && (
            <Row label="Sub-agents" count={session.agents!.length}>
              {session.agents!.map(a => (
                <Chip key={a}>{a}</Chip>
              ))}
            </Row>
          )}

          {(session.memoryPaths?.length ?? 0) > 0 && (
            <Row label="Memory" count={session.memoryPaths!.length}>
              {session.memoryPaths!.map(p => (
                <Chip key={p} title={p}>
                  {p.length > 60 ? `…${p.slice(-58)}` : p}
                </Chip>
              ))}
            </Row>
          )}

          {session.cwd && (
            <Row label="cwd">
              <span className="text-[10px] font-mono text-muted-foreground break-all">{session.cwd}</span>
            </Row>
          )}
        </div>
      )}
    </div>
  );
};

export default AgentSessionPanel;
