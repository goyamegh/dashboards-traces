/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ContextValueView
 *
 * Renders a single test-case `context` item (`AgentContextItem`, types/index.ts)
 * on the Test Case detail page (`TestCaseDetailPage.tsx`). Fixes the "Context"
 * section rendering raw, truncated JSON one-liners — e.g. the "Detect Error
 * Codes" test case showed `{"appId":"explore","timeRange":{"from":"now-15m",...`
 * (`ctx.value.slice(0, 100)`) instead of something a human can read.
 *
 * Behavior:
 *   - JSON values (`formatContextValue` from `@/lib/contextFormat`) are
 *     pretty-printed (2-space indent), syntax-highlighted via prismjs (same
 *     library + pattern as `EvalSourceCodeView.tsx`), and shown UNTRUNCATED
 *     in a scrollable monospace block.
 *   - Non-JSON values (plain notes, log lines, etc.) render as plain
 *     wrapped text — also untruncated.
 *   - Each item is an independently collapsible block (chevron toggle) so a
 *     large context payload doesn't dominate the page, but defaults OPEN:
 *     the point of this component is to be readable on arrival, not to add
 *     another click before the user can see what's being evaluated.
 *
 * Deliberately scoped to CONTENT rendering only — no page layout changes.
 * (opensearch-project/agent-health#420 is stacked on with a full
 * definition-first page redesign; this component only replaces the
 * pre-existing per-item `<pre>{ctx.value.slice(0, 100)}...</pre>` block.)
 */

import React, { useMemo, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-json.js';
import { ChevronRight, ChevronDown, Braces } from 'lucide-react';
import { formatContextValue } from '@/lib/contextFormat';

interface ContextValueViewProps {
  /** Item label — `AgentContextItem.description`, or a positional fallback. */
  title: string;
  /** Raw `AgentContextItem.value` (opaque string; often JSON). */
  value: string;
  /** Whether the block starts expanded. Default: true (see module docs). */
  defaultOpen?: boolean;
  /** Max height of the scrollable value region. Default: 160px. */
  maxHeight?: string;
  className?: string;
}

function highlightJson(code: string): string {
  try {
    return Prism.highlight(code, Prism.languages.json, 'json');
  } catch {
    // Prism should never throw on well-formed JSON.stringify output, but
    // fail open to escaped plain text rather than crashing the page.
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

export const ContextValueView: React.FC<ContextValueViewProps> = ({
  title,
  value,
  defaultOpen = true,
  maxHeight = '160px',
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  const { isJson, pretty } = useMemo(() => formatContextValue(value), [value]);

  // Highlight only while open — matches EvalSourceCodeView's "don't pay the
  // Prism cost for collapsed content" approach, though this component
  // defaults open.
  const highlightedHtml = useMemo(
    () => (open && isJson ? highlightJson(pretty) : ''),
    [open, isJson, pretty]
  );

  return (
    <div
      className={`bg-muted/30 rounded border border-border overflow-hidden ${className || ''}`}
      data-testid="context-value-view"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 w-full text-left px-2 py-1 hover:bg-muted/50"
        aria-expanded={open}
        data-testid="context-value-toggle"
        title={open ? 'Collapse context item' : 'Expand context item'}
      >
        {open
          ? <ChevronDown size={9} className="text-muted-foreground shrink-0" />
          : <ChevronRight size={9} className="text-muted-foreground shrink-0" />}
        <span className="text-[9px] font-medium text-muted-foreground truncate flex-1 min-w-0">
          {title}
        </span>
        {isJson && (
          <span className="flex items-center gap-0.5 text-[8px] text-muted-foreground/70 shrink-0" title="Valid JSON, pretty-printed">
            <Braces size={8} /> JSON
          </span>
        )}
      </button>

      {open && (
        isJson ? (
          <pre
            data-testid="context-value-pretty"
            className="text-[9px] font-mono overflow-auto m-0 px-2 py-1.5 border-t border-border whitespace-pre leading-relaxed"
            style={{ maxHeight }}
          >
            <code
              className="context-value-highlight"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          </pre>
        ) : (
          <pre
            data-testid="context-value-plain"
            className="text-[9px] font-mono overflow-auto m-0 px-2 py-1.5 border-t border-border whitespace-pre-wrap break-words leading-relaxed"
            style={{ maxHeight }}
          >
            {pretty}
          </pre>
        )
      )}
    </div>
  );
};

export default ContextValueView;
