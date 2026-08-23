/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit: sanitizeMarkdownUrl — the XSS guard on the LLM-authored deep-dive
 * markdown. ReactMarkdown's default URL sanitization is replaced by this
 * transform (so our custom `span:` scheme survives), so it MUST drop dangerous
 * schemes. Regression for the Code-Diff-Analyzer medium finding on
 * components/comparison/ComparisonDeepDive.tsx (urlTransform={(u) => u}).
 */

import { sanitizeMarkdownUrl } from '@/components/comparison/sanitizeMarkdownUrl';

describe('sanitizeMarkdownUrl', () => {
  it('passes the custom span: scheme through untouched (handled by SpanAnchor)', () => {
    expect(sanitizeMarkdownUrl('span:subprocess-123:abcd1234')).toBe('span:subprocess-123:abcd1234');
    expect(sanitizeMarkdownUrl('span:run-1:7423caa65a80e3b6')).toBe('span:run-1:7423caa65a80e3b6');
  });

  it('allows safe schemes and relative URLs', () => {
    for (const u of [
      'https://example.com/traces?x=1',
      'http://localhost:4001/x',
      'mailto:a@b.com',
      '/runs/abc',
      '#section',
      './rel',
      '../up',
    ]) {
      expect(sanitizeMarkdownUrl(u)).toBe(u);
    }
  });

  it('drops javascript: and other dangerous schemes to empty string', () => {
    for (const u of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(document.cookie)  ',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(sanitizeMarkdownUrl(u)).toBe('');
    }
  });

  it('handles empty / nullish input', () => {
    expect(sanitizeMarkdownUrl('')).toBe('');
    // @ts-expect-error exercising defensive nullish path
    expect(sanitizeMarkdownUrl(undefined)).toBe('');
  });

  it('a span:-shaped value passes through (SpanAnchor renders it as a button, never an <a href>)', () => {
    // Matches span:<id>:<rest>, so it survives the transform; SpanAnchor turns
    // it into an onClick button (no href), so even a weird payload can't
    // navigate or execute a scheme.
    expect(sanitizeMarkdownUrl('span:javascript:alert(1)')).toBe('span:javascript:alert(1)');
  });
});
