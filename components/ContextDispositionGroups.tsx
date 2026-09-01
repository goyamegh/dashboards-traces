/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { AgentContextItem } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/ui/markdown';
import { ContextValueView } from '@/components/evals3/ContextValueView';

interface ContextDispositionGroupsProps {
  items: AgentContextItem[];
  compact?: boolean;
}

/**
 * Shared, delivery-aware context rendering for definition and detail views.
 * Legacy items without a disposition are delivered to the agent.
 */
export const ContextDispositionGroups: React.FC<ContextDispositionGroupsProps> = ({
  items,
  compact = false,
}) => {
  const delivered = items.filter(item => !item.disposition || item.disposition === 'prompt');
  const directives = items.filter(item => item.disposition === 'connector');
  const documentation = items.filter(item => item.disposition === 'documentation');
  const textClass = compact ? 'text-[10px]' : 'text-xs';
  const headingClass = 'text-[9px] font-semibold text-muted-foreground uppercase tracking-wider';

  return (
    <div className="space-y-3" data-testid="context-disposition-groups">
      <p className={`${textClass} text-muted-foreground`} data-testid="context-delivery-summary">
        Agent receives: prompt + {delivered.length} context items · directives: {directives.length} · documentation: {documentation.length}
      </p>

      {delivered.length > 0 && (
        <div className="space-y-1.5">
          <h4 className={headingClass}>Delivered to agent</h4>
          {delivered.map((item, index) => (
            <ContextValueView
              key={index}
              title={item.description || `Context item ${index + 1}`}
              value={item.value}
              maxHeight="128px"
            />
          ))}
        </div>
      )}

      {directives.length > 0 && (
        <div className="space-y-1.5">
          <h4 className={headingClass}>Connector directive — not delivered</h4>
          <div className="flex flex-wrap gap-2">
            {directives.map((item, index) => (
              <Badge key={index} variant="outline" className={`${textClass} font-mono max-w-full whitespace-normal break-all`}>
                {item.description}: {item.value}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {documentation.length > 0 && (
        <div className="space-y-1.5">
          <h4 className={headingClass}>Documentation — not delivered</h4>
          {documentation.map((item, index) => (
            <div key={index} className="bg-card rounded border border-border px-3 py-2 min-w-0">
              <p className={`${textClass} font-medium text-muted-foreground break-words mb-2`}>
                {item.description}
              </p>
              <Markdown className={textClass}>{item.value}</Markdown>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
