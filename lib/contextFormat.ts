/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure formatting helper for `AgentContextItem.value` (types/index.ts):
 * test-case context entries are persisted as an opaque string, but in
 * practice the vast majority are JSON blobs (OpenSearch query bodies, alert
 * payloads, etc.) — see the "Detect Error Codes" test case whose context
 * renders as a raw truncated one-liner like
 * `{"appId":"explore","timeRange":{"from":"now-15m",...` today.
 *
 * `formatContextValue()` detects that case and returns a pretty-printed
 * (2-space indent), untruncated string for structural JSON, while leaving
 * plain-text context (free-form notes, log lines, etc.) untouched. Kept as
 * a standalone pure function — no React, no Prism — so it's trivial to
 * unit test in isolation from the DOM/highlighting concerns that live in
 * `components/evals3/ContextValueView.tsx`.
 */

export interface FormattedContextValue {
  /** True when `value` parsed as a JSON object or array. */
  isJson: boolean;
  /**
   * `JSON.stringify(parsed, null, 2)` when `isJson`, otherwise the original
   * `value` unchanged (and un-truncated).
   */
  pretty: string;
}

export function formatContextValue(value: string): FormattedContextValue {
  if (typeof value !== 'string' || value.trim() === '') {
    return { isJson: false, pretty: value ?? '' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Not valid JSON (plain text, a log line, unquoted keys, etc.) — render
    // verbatim rather than guessing at a "fix".
    return { isJson: false, pretty: value };
  }

  // Bare JSON primitives (a quoted string, a number, a boolean, null) parse
  // successfully but pretty-printing them buys nothing over the raw value —
  // reserve the structural JSON treatment (indentation, syntax highlight,
  // collapsible block) for objects/arrays, which is what actually renders
  // as an unreadable one-liner today.
  if (parsed === null || typeof parsed !== 'object') {
    return { isJson: false, pretty: value };
  }

  return { isJson: true, pretty: JSON.stringify(parsed, null, 2) };
}
