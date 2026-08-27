/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CollapsibleTestCaseDefinition
 *
 * Reusable collapsible card that surfaces the *full* definition of a
 * test case — used at the top of the right detail pane on both
 * TestCaseDetailPage (test-case-run inspection) and RunInspectorPage
 * (benchmark-run inspection).
 *
 * Two shapes depending on provenance:
 *
 *   • SDK / code-imported tests (`testCase.sourceFile` set) — show the
 *     file path plus the full eval-file source as an IDE-style code view
 *     (EvalSourceCodeView). We still can't render the `evaluate` function
 *     body in isolation (it's a JS closure at runtime), but the whole file
 *     that defines it is captured at import time and rendered here.
 *
 *   • JSON tests (no sourceFile) — show the full TestCase object as
 *     pretty-printed JSON. **No truncation** — the whole point of
 *     opening this section is to see the full prompt / expected
 *     outcomes / labels at once.
 *
 * Defaults to closed; opens on header click. The component is small and
 * stateless from the caller's perspective — drop it in wherever a
 * `testCase` is in scope.
 */

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileCode2, Braces, Copy, Check } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { EvalSourceCodeView } from '@/components/evals3/EvalSourceCodeView';

interface CollapsibleTestCaseDefinitionProps {
  testCase: TestCase | null;
  /** Whether the section starts open. Default: false (collapsed). */
  defaultOpen?: boolean;
  className?: string;
}

export const CollapsibleTestCaseDefinition: React.FC<CollapsibleTestCaseDefinitionProps> = ({
  testCase,
  defaultOpen = false,
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  if (!testCase) return null;

  const isSdk = !!testCase.sourceFile;
  // Pretty-print the full TestCase. The whole point of the JSON view is to
  // show the user exactly what would round-trip through `agent-health
  // export` — so include every field, including labels / expectedOutcomes /
  // versions, untruncated.
  const json = isSdk ? '' : JSON.stringify(testCase, null, 2);

  // JSON branch only — the SDK branch's copy affordance lives inside
  // EvalSourceCodeView's header (copies the full source, not just the path).
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = json;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className={`border-b bg-muted/30 shrink-0 ${className || ''}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-1.5 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown size={12} className="text-muted-foreground shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Test Case Definition
          </span>
          {isSdk ? (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 gap-1 shrink-0">
              <FileCode2 size={9} /> SDK
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 gap-1 shrink-0">
              <Braces size={9} /> JSON
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground truncate" title={testCase.name}>
            {testCase.name}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {isSdk ? (
            // SDK test: EvalSourceCodeView IS the whole surface — its own
            // header already shows the source path + language badge + line
            // count + copy button, so the old standalone "Source File" row
            // and sha256 line were redundant duplicates (owner feedback).
            <EvalSourceCodeView testCase={testCase} maxHeight="360px" />
          ) : (
            // JSON test: full untruncated pretty-print, copyable.
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Full Definition (JSON)
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
                  title="Copy JSON"
                >
                  {copied ? (
                    <><Check size={10} className="text-green-600" /> Copied</>
                  ) : (
                    <><Copy size={10} /> Copy</>
                  )}
                </button>
              </div>
              {/* No max-height / no scroll — user explicitly wants no truncation.
                  The outer page already provides scroll if the JSON gets very tall. */}
              <pre className="text-[10px] font-mono bg-card border border-border rounded p-3 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed">
                {json}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CollapsibleTestCaseDefinition;
