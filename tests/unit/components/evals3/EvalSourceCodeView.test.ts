/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for EvalSourceCodeView — the IDE-style code viewer for
 * code-SDK / code-imported test cases on the Test Case detail page.
 *
 * Covers:
 * - Render conditions: null for non-code-SDK test cases (no sourceFile),
 *   null for a null testCase, placeholder for code-SDK test cases missing
 *   sourceCode (pre-feature backfill case), full code view otherwise.
 * - Line-number gutter matches the number of lines in sourceCode.
 * - Syntax highlighting: emits Prism `.token` spans for known JS/TS tokens.
 * - Language badge reflects `sourceLanguage` (persisted) or falls back to
 *   extension-based detection when absent.
 * - Copy button copies the raw (unhighlighted) sourceCode to the clipboard.
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { EvalSourceCodeView } from '@/components/evals3/EvalSourceCodeView';
import type { TestCase } from '@/types';

const h = React.createElement;

/** Expand the collapsed-by-default panel via its header toggle. */
function expandPanel() {
  fireEvent.click(screen.getByTestId('eval-source-toggle'));
}

function baseTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Test Case',
    description: '',
    labels: [],
    category: 'General',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    context: [],
    ...overrides,
  } as TestCase;
}

describe('EvalSourceCodeView — render conditions', () => {
  it('renders nothing for a null testCase', () => {
    const { container } = render(h(EvalSourceCodeView, { testCase: null }));
    expect(container.children.length).toBe(0);
  });

  it('renders nothing for a JSON test case (no sourceFile)', () => {
    const tc = baseTestCase({ sourceFile: undefined });
    const { container } = render(h(EvalSourceCodeView, { testCase: tc }));
    expect(container.children.length).toBe(0);
  });

  it('renders a "source not captured" placeholder for a code-SDK test case with no sourceCode', () => {
    const tc = baseTestCase({ sourceFile: 'evals/legacy.eval.js', sourceHash: 'abc123' });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    expect(screen.getByText(/source not captured at import/i)).toBeTruthy();
    expect(screen.getAllByText('evals/legacy.eval.js').length).toBeGreaterThan(0);
    // No code body / line-number gutter when there's nothing to show.
    expect(screen.queryByTestId('eval-source-code-body')).toBeNull();
  });

  it('renders the full IDE-style code view when sourceCode is present', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/rca.eval.ts',
      sourceFileName: 'rca.eval.ts',
      sourceLanguage: 'typescript',
      sourceCode: "import { test } from '@opensearch-project/agent-health';\ntest('a', () => {});\n",
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expect(screen.getByTestId('eval-source-code-view')).toBeTruthy();
    // Collapsed by default: header (full source path/badge) visible, code body NOT.
    expect(screen.getByText('evals/rca.eval.ts')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.queryByTestId('eval-source-code-body')).toBeNull();
    expect(screen.getByTestId('eval-source-toggle').getAttribute('aria-expanded')).toBe('false');
    // Expanding reveals the full code body.
    expandPanel();
    expect(screen.getByTestId('eval-source-code-body')).toBeTruthy();
    expect(screen.getByTestId('eval-source-toggle').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('EvalSourceCodeView — collapse/expand', () => {
  it('starts expanded when defaultOpen is passed', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/open.eval.js',
      sourceCode: 'const x = 1;',
    });
    render(h(EvalSourceCodeView, { testCase: tc, defaultOpen: true }));
    expect(screen.getByTestId('eval-source-code-body')).toBeTruthy();
  });

  it('toggles closed again on a second header click', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/toggle.eval.js',
      sourceCode: 'const x = 1;',
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    expect(screen.getByTestId('eval-source-code-body')).toBeTruthy();
    expandPanel(); // second click collapses
    expect(screen.queryByTestId('eval-source-code-body')).toBeNull();
  });

  it('copy button works while collapsed (header is always visible)', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const sourceCode = 'const collapsedCopy = true;';
    const tc = baseTestCase({ sourceFile: 'evals/cc.eval.js', sourceCode });
    render(h(EvalSourceCodeView, { testCase: tc }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy source/i }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(sourceCode);
  });
});

describe('EvalSourceCodeView — line numbers', () => {
  it('renders one gutter line number per line of sourceCode', () => {
    const sourceCode = 'line1\nline2\nline3';
    const tc = baseTestCase({
      sourceFile: 'evals/three-lines.eval.js',
      sourceFileName: 'three-lines.eval.js',
      sourceCode,
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    const gutter = screen.getByTestId('eval-source-line-numbers');
    expect(gutter.textContent).toBe('1\n2\n3');
  });

  it('recomputes the gutter for a single-line file', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/one-line.eval.js',
      sourceCode: 'test("a", () => {});',
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    expect(screen.getByTestId('eval-source-line-numbers').textContent).toBe('1');
  });
});

describe('EvalSourceCodeView — syntax highlighting', () => {
  it('emits Prism keyword tokens for JS/TS keywords', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/kw.eval.ts',
      sourceLanguage: 'typescript',
      sourceCode: "const x: number = 1;\nfunction f() { return x; }\n",
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    const body = screen.getByTestId('eval-source-code-body');
    const keywordTokens = within(body).getAllByText((_text, el) =>
      !!el?.classList.contains('token') && el.classList.contains('keyword')
    );
    expect(keywordTokens.length).toBeGreaterThan(0);
  });

  it('falls back to extension-based language detection when sourceLanguage is absent', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/legacy-lang.eval.js',
      // sourceLanguage intentionally omitted — older imports predate the field.
      sourceCode: "const x = 1;\n",
    });
    render(h(EvalSourceCodeView, { testCase: tc }));
    // .js extension -> JavaScript badge, not TypeScript.
    expect(screen.getByText('JavaScript')).toBeTruthy();
  });
});

describe('EvalSourceCodeView — XSS hardening', () => {
  // Regression coverage for the Code-Diff-Analyzer bot's Medium finding on
  // `dangerouslySetInnerHTML` in the Prism-highlighted render path.
  // `sourceCode` is import-controlled: users import arbitrary `.eval.js`/
  // `.eval.ts` files and the RAW file contents are persisted verbatim as
  // `testCase.sourceCode`, then rendered here. A malicious eval file must
  // never be able to break out of the `<code>` element or execute script —
  // it must render as inert, escaped TEXT, in every language/detection
  // branch (explicit `sourceLanguage`, extension-detected JS, and
  // extension-detected TS).
  const XSS_PAYLOAD =
    'const x = 1; </code><img src=x onerror="window.__xss=1">' +
    '</script><script>window.__xss2=1</script>';

  function assertRenderedInert(container: HTMLElement) {
    // 1. No attacker element was materialized into the real DOM.
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelectorAll('script').length).toBe(0);
    // 2. Neither onerror nor the injected <script> body executed.
    expect((window as any).__xss).toBeUndefined();
    expect((window as any).__xss2).toBeUndefined();
    // 3. The payload survives as literal, readable text (not silently
    //    dropped — it must still be visible/copyable source, just inert).
    const body = within(container).getByTestId('eval-source-code-body');
    expect(body.textContent).toContain(XSS_PAYLOAD);
  }

  afterEach(() => {
    delete (window as any).__xss;
    delete (window as any).__xss2;
  });

  it('renders a hostile payload as inert text for an explicit typescript sourceLanguage', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/hostile.eval.ts',
      sourceLanguage: 'typescript',
      sourceCode: XSS_PAYLOAD,
    });
    const { container } = render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    assertRenderedInert(container);
  });

  it('renders a hostile payload as inert text for an explicit javascript sourceLanguage', () => {
    const tc = baseTestCase({
      sourceFile: 'evals/hostile.eval.js',
      sourceLanguage: 'javascript',
      sourceCode: XSS_PAYLOAD,
    });
    const { container } = render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    assertRenderedInert(container);
  });

  it('renders a hostile payload as inert text via the extension-detected fallback (no sourceLanguage persisted)', () => {
    // Older imports predate the `sourceLanguage` field entirely, so this
    // exercises the `detectSourceLanguage()` fallback branch, not just the
    // explicit-language branch.
    const tc = baseTestCase({
      sourceFile: 'evals/hostile-legacy.eval.js',
      sourceCode: XSS_PAYLOAD,
    });
    const { container } = render(h(EvalSourceCodeView, { testCase: tc }));
    expandPanel();
    assertRenderedInert(container);
  });
});

describe('EvalSourceCodeView — copy button', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('copies the raw sourceCode (not the highlighted HTML) to the clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const sourceCode = "const x = 1; // comment\n";
    const tc = baseTestCase({
      sourceFile: 'evals/copy.eval.js',
      sourceCode,
    });
    render(h(EvalSourceCodeView, { testCase: tc }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy source/i }));
      // Let the `await navigator.clipboard.writeText(...)` inside the
      // click handler resolve before asserting, so the subsequent
      // `setCopied(true)` state update doesn't fire after this test's act()
      // scope has already closed.
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(sourceCode);
  });

  it('disables the copy button when there is no sourceCode to copy', () => {
    const tc = baseTestCase({ sourceFile: 'evals/legacy.eval.js' });
    render(h(EvalSourceCodeView, { testCase: tc }));
    const button = screen.getByRole('button', { name: /copy source/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
