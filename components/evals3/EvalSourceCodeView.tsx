/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EvalSourceCodeView
 *
 * IDE-style read-only viewer for the eval-file source of a code-SDK /
 * code-imported test case (`testCase.sourceFile` set — see
 * `lib/testCases/loader.ts` and `cli/commands/benchmark.ts`). Renders the
 * ENTIRE persisted `sourceCode` with:
 *   - line numbers in a sticky, non-scrolling gutter
 *   - TS/JS syntax highlighting via prismjs
 *   - a sticky filename header (path, language badge, line count, copy)
 *   - horizontal + vertical scroll for long/wide files (no truncation)
 *
 * COLLAPSED BY DEFAULT: the filename header is always visible (so the user
 * can see this is a code-SDK test case and which file defines it), and
 * clicking it expands the code panel — matching the pre-existing
 * "Test Case Definition" collapsible behavior where SDK source details
 * were hidden until asked for. Pass `defaultOpen` to start expanded.
 *
 * Renders `null` for non-code-SDK test cases (no `sourceFile`). For
 * code-SDK test cases persisted BEFORE `sourceCode` existed as a field
 * (older imports), shows a "source not captured at import" placeholder
 * (when expanded) instead of a blank/broken code view — see types/index.ts
 * TestCase docs.
 *
 * Used on both the Test Case detail page (TestCaseDetailPage.tsx) and the
 * reusable run-definition collapsible (CollapsibleTestCaseDefinition.tsx)
 * so SDK provenance renders identically wherever a TestCase is in scope.
 */

import React, { useMemo, useState } from 'react';
import Prism from 'prismjs';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-clike.js';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-javascript.js';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-typescript.js';
import { FileCode2, Copy, Check, AlertCircle, ChevronRight, ChevronDown } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { detectSourceLanguage } from '@/lib/utils';

interface EvalSourceCodeViewProps {
  testCase: TestCase | null;
  className?: string;
  /** Max height of the scrollable code region. Default: 480px. */
  maxHeight?: string;
  /** Whether the code panel starts expanded. Default: false (collapsed). */
  defaultOpen?: boolean;
}

function highlight(code: string, language: 'javascript' | 'typescript'): string {
  const grammar = language === 'javascript' ? Prism.languages.javascript : Prism.languages.typescript;
  try {
    return Prism.highlight(code, grammar, language);
  } catch {
    // Prism should never throw on arbitrary text, but if it somehow does,
    // fail open to escaped plain text rather than crashing the page.
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

export const EvalSourceCodeView: React.FC<EvalSourceCodeViewProps> = ({
  testCase,
  className,
  maxHeight = '480px',
  defaultOpen = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  const isCodeSdk = !!testCase?.sourceFile;

  const language = useMemo(
    () => detectSourceLanguage(testCase?.sourceFileName || testCase?.sourceFile || ''),
    [testCase?.sourceFileName, testCase?.sourceFile]
  );

  // Highlight only once the panel has been opened — collapsed rows never pay
  // the Prism cost. useMemo keeps the result cached across re-renders after.
  const highlightedHtml = useMemo(() => {
    if (!open || !testCase?.sourceCode) return '';
    return highlight(testCase.sourceCode, testCase.sourceLanguage || language);
  }, [open, testCase?.sourceCode, testCase?.sourceLanguage, language]);

  const lineCount = testCase?.sourceCode ? testCase.sourceCode.split('\n').length : 0;
  // Must run unconditionally (before the early `return null` below) — React
  // hooks can't be called conditionally without breaking the hooks order
  // invariant across renders.
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
    [lineCount]
  );

  if (!testCase || !isCodeSdk) return null;

  // Show the full relative path, not just the basename — this header is now
  // the ONLY place the source path appears (the old standalone "Source
  // File" row in CollapsibleTestCaseDefinition was removed as redundant),
  // and `dist/wixqa.eval.js` is more useful than `wixqa.eval.js` when a
  // repo has several eval dirs. Tooltip carries the sha256 drift hash the
  // removed row used to show.
  const fileName = testCase.sourceFile || testCase.sourceFileName || 'source file';
  const headerTitle = testCase.sourceHash
    ? `${testCase.sourceFile}\nsha256: ${testCase.sourceHash.slice(0, 16)}…`
    : testCase.sourceFile;

  const handleCopy = async (e: React.MouseEvent) => {
    // The copy button sits next to (not inside) the toggle button, but keep
    // stopPropagation defensive in case a parent adds a click handler.
    e.stopPropagation();
    if (!testCase.sourceCode) return;
    try {
      await navigator.clipboard.writeText(testCase.sourceCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className={`border border-border rounded overflow-hidden ${className || ''}`} data-testid="eval-source-code-view">
      {/* Sticky header: chevron + filename + language badge + line count as
          the expand/collapse toggle, with the copy button as a SIBLING (a
          <button> can't nest inside another <button>). Sticky so it stays
          visible when the expanded code region scrolls inside a taller
          parent list. */}
      <div className={`sticky top-0 z-10 flex items-center gap-2 bg-card px-3 py-1.5 ${open ? 'border-b border-border' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          aria-expanded={open}
          data-testid="eval-source-toggle"
          title={open ? 'Collapse eval source' : 'Expand eval source'}
        >
          {open
            ? <ChevronDown size={12} className="text-muted-foreground shrink-0" />
            : <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
          <FileCode2 size={12} className="text-muted-foreground shrink-0" />
          <span className="text-[11px] font-mono font-medium truncate flex-1" title={headerTitle}>
            {fileName}
          </span>
        </button>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">
          {(testCase.sourceLanguage || language) === 'typescript' ? 'TypeScript' : 'JavaScript'}
        </Badge>
        {testCase.sourceCode && (
          <span className="text-[9px] text-muted-foreground shrink-0">{lineCount} lines</span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          disabled={!testCase.sourceCode}
          className="p-1 rounded hover:bg-muted shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Copy source"
          aria-label="Copy source"
        >
          {copied ? <Check size={11} className="text-green-600" /> : <Copy size={11} className="text-muted-foreground" />}
        </button>
      </div>

      {open && (testCase.sourceCode ? (
        <div
          className="eval-source-code overflow-auto"
          style={{ maxHeight }}
          data-testid="eval-source-code-body"
        >
          <div className="flex text-[11px] leading-5 font-mono">
            <pre
              aria-hidden="true"
              data-testid="eval-source-line-numbers"
              className="sticky left-0 z-[1] select-none text-right pr-3 pl-3 py-3 m-0 text-muted-foreground/50 bg-muted/40 border-r border-border shrink-0"
            >
              {lineNumbers}
            </pre>
            <pre className="flex-1 py-3 pl-3 pr-4 m-0">
              <code
                className="eval-source-highlight"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </pre>
          </div>
        </div>
      ) : (
        // Backfill placeholder — code-SDK test case persisted before
        // `sourceCode` existed as a field. Don't pretend we have the file;
        // surface the path so the user can still find it manually.
        <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-muted-foreground bg-muted/20">
          <AlertCircle size={13} className="shrink-0 mt-0.5 text-amber-500" />
          <div className="space-y-1 min-w-0">
            <p className="italic">Source not captured at import.</p>
            <p className="font-mono break-all opacity-80">{testCase.sourceFile}</p>
            <p className="opacity-70">
              This test case was imported before source-capture was added. Re-run{' '}
              <code className="font-mono">agent-health benchmark -f {testCase.sourceFile}</code> to
              backfill it.
            </p>
          </div>
        </div>
      ))}
    </div>
  );
};

export default EvalSourceCodeView;
