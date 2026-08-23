/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Markdown — the single shared markdown renderer for agent / judge / prompt
 * text. Before this existed, three surfaces (assistant trajectory, tool
 * results, judge reasoning, test-case prompts) each rendered markdown
 * differently — or not at all, dumping raw `**bold**` / `## headings` /
 * unindented lists as plain text. Routing them all through one component
 * keeps the prose styling (heading sizes, list indentation, inline code)
 * consistent everywhere.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { hasRealMarkdown } from '@/lib/markdown';

export { hasRealMarkdown };

// Prose styling tuned for the dense, dark eval UI: tight vertical rhythm,
// real list indentation (pl-5) so bullets/numbers read as structure rather
// than wrapping flush to the margin, and inline code in the brand blue.
const PROSE_CLASSES =
  'prose prose-sm dark:prose-invert max-w-none ' +
  'prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1 prose-headings:first:mt-0 ' +
  'prose-p:my-1 prose-p:first:mt-0 prose-p:leading-relaxed ' +
  'prose-strong:text-foreground ' +
  'prose-code:text-opensearch-blue prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none ' +
  'prose-pre:bg-muted prose-pre:text-xs prose-pre:p-3 ' +
  'prose-ul:my-1 prose-ul:pl-5 prose-ol:my-1 prose-ol:pl-5 prose-li:my-0 prose-li:leading-relaxed';

interface MarkdownProps {
  children: string;
  className?: string;
}

export const Markdown: React.FC<MarkdownProps> = ({ children, className }) => (
  <div className={cn(PROSE_CLASSES, className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

export default Markdown;
