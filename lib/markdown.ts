/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure markdown helpers. Kept free of any `react-markdown` import so it can be
 * unit-tested under Jest's CJS loader (react-markdown is ESM-only and isn't
 * transformed). The React rendering wrapper lives in components/ui/markdown.tsx.
 */

/**
 * Heuristic: does this string contain syntax the author intended as Markdown
 * (bold, headings, fenced code, real multi-item lists, links, block quotes)?
 *
 * Used to decide whether structured/agent output (e.g. a tool result that
 * might be raw JSON) should render as Markdown or stay a monospace <pre>.
 * Plain prose with a single leading `1. …` sentence is NOT treated as
 * markdown — running it through a renderer fragments it into a lonely <ol>.
 */
export function hasRealMarkdown(text: string): boolean {
  if (!text) return false;
  if (/\*\*[^*\n]+\*\*/.test(text)) return true; // bold
  if (/__[^_\n]+__/.test(text)) return true; // bold (underscore)
  if (/^#{1,6}\s+\S/m.test(text)) return true; // headings
  if (/```/.test(text)) return true; // fenced code
  if (/`[^`\n]+`/.test(text)) return true; // inline code
  if (/!?\[[^\]]+\]\([^)]+\)/.test(text)) return true; // links / images
  if (/(^|\n)[*\-]\s+\S.*\n[*\-]\s+/.test(text)) return true; // bullet list (>=2)
  if (/(^|\n)\d+\.\s+\S.*\n\d+\.\s+/.test(text)) return true; // numbered list (>=2)
  if (/^>\s/m.test(text)) return true; // block quote
  return false;
}
