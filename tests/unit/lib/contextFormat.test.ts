/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `formatContextValue` — the JSON-detect/pretty-print/fallback
 * helper behind the Test Case detail page's Context section fix (raw
 * truncated JSON one-liners like `{"appId":"explore","timeRange":{"from":
 * "now-15m",...` were the reported bug).
 */

import { formatContextValue } from '@/lib/contextFormat';

describe('formatContextValue', () => {
  it('pretty-prints a JSON object with 2-space indentation, untruncated', () => {
    const raw = JSON.stringify({
      appId: 'explore',
      timeRange: { from: 'now-15m', to: 'now' },
      filters: Array.from({ length: 20 }, (_, i) => `filter-${i}`),
    });

    const result = formatContextValue(raw);

    expect(result.isJson).toBe(true);
    expect(result.pretty).not.toBe(raw); // actually reformatted, not passed through
    expect(result.pretty).toContain('\n  "appId": "explore"');
    expect(result.pretty).toContain('\n    "from": "now-15m"');
    // Every original filter value must survive — pretty-printing must not
    // truncate the way the old `ctx.value.slice(0, 100)` did.
    expect(result.pretty).toContain('filter-19');
  });

  it('pretty-prints a JSON array', () => {
    const raw = JSON.stringify([{ id: 1 }, { id: 2 }]);
    const result = formatContextValue(raw);

    expect(result.isJson).toBe(true);
    expect(result.pretty).toBe(JSON.stringify([{ id: 1 }, { id: 2 }], null, 2));
    expect(result.pretty.split('\n').length).toBeGreaterThan(1);
  });

  it('falls back to the original text for non-JSON content', () => {
    const raw = 'Alert fired: web-server-01 CPU > 90% for 5 minutes straight.';
    const result = formatContextValue(raw);

    expect(result.isJson).toBe(false);
    expect(result.pretty).toBe(raw);
  });

  it('falls back to the original text for malformed JSON', () => {
    const raw = '{"appId":"explore","timeRange":'; // truncated/invalid on purpose
    const result = formatContextValue(raw);

    expect(result.isJson).toBe(false);
    expect(result.pretty).toBe(raw);
  });

  it('treats bare JSON primitives as non-structural (no pretty-print benefit)', () => {
    expect(formatContextValue('42')).toEqual({ isJson: false, pretty: '42' });
    expect(formatContextValue('true')).toEqual({ isJson: false, pretty: 'true' });
    expect(formatContextValue('null')).toEqual({ isJson: false, pretty: 'null' });
    expect(formatContextValue('"just a quoted string"')).toEqual({
      isJson: false,
      pretty: '"just a quoted string"',
    });
  });

  it('handles empty and whitespace-only values without throwing', () => {
    expect(formatContextValue('')).toEqual({ isJson: false, pretty: '' });
    expect(formatContextValue('   ')).toEqual({ isJson: false, pretty: '   ' });
  });

  it('pretty-prints nested structures fully (regression: no depth limit)', () => {
    const raw = JSON.stringify({ a: { b: { c: { d: 'deep' } } } });
    const result = formatContextValue(raw);

    expect(result.isJson).toBe(true);
    expect(result.pretty).toContain('"d": "deep"');
  });
});
