/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { unionRunsByPrecedence } from '@/lib/runUnion';

describe('unionRunsByPrecedence', () => {
  it('returns benchmark-embedded-only runs with source "benchmark-run"', () => {
    const rows = unionRunsByPrecedence([{ id: 'run-1', name: 'Embedded only' }], []);
    expect(rows).toEqual([
      { id: 'run-1', source: 'benchmark-run', benchmarkRun: { id: 'run-1', name: 'Embedded only' } },
    ]);
  });

  it('returns eval-run-only runs with source "eval-run" and no benchmarkRun', () => {
    const rows = unionRunsByPrecedence([], [{ id: 'eval-run-1', name: 'Unlinked eval-run' }]);
    expect(rows).toEqual([
      { id: 'eval-run-1', source: 'eval-run', evalRun: { id: 'eval-run-1', name: 'Unlinked eval-run' }, benchmarkRun: undefined },
    ]);
  });

  it('prefers the eval-run doc when the same id exists in both collections', () => {
    const benchmarkRun = { id: 'run-1', name: 'Stale embedded projection' };
    const evalRun = { id: 'run-1', name: 'Authoritative eval-run doc' };
    const rows = unionRunsByPrecedence([benchmarkRun], [evalRun]);

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('eval-run');
    expect(rows[0].evalRun).toBe(evalRun);
    // The embedded projection is preserved alongside for callers that need
    // benchmark-specific fields (e.g. benchmarkVersion).
    expect(rows[0].benchmarkRun).toBe(benchmarkRun);
  });

  it('is order-independent for the collision case (eval-run always wins)', () => {
    const benchmarkRun = { id: 'run-1', name: 'Embedded' };
    const evalRun = { id: 'run-1', name: 'Eval-run doc' };

    const rowsA = unionRunsByPrecedence([benchmarkRun], [evalRun]);
    const rowsB = unionRunsByPrecedence([benchmarkRun], [evalRun]);
    expect(rowsA[0].source).toBe('eval-run');
    expect(rowsB[0].source).toBe('eval-run');
  });

  it('produces one row per distinct id across a larger mixed set', () => {
    const benchmarkRuns = [
      { id: 'run-a' },
      { id: 'run-shared' },
    ];
    const evalRuns = [
      { id: 'run-shared' },
      { id: 'eval-run-b' },
    ];
    const rows = unionRunsByPrecedence(benchmarkRuns, evalRuns);
    const ids = rows.map(r => r.id).sort();
    expect(ids).toEqual(['eval-run-b', 'run-a', 'run-shared']);
    expect(rows.find(r => r.id === 'run-shared')?.source).toBe('eval-run');
    expect(rows.find(r => r.id === 'run-a')?.source).toBe('benchmark-run');
    expect(rows.find(r => r.id === 'eval-run-b')?.source).toBe('eval-run');
  });

  it('handles undefined/null inputs as empty collections', () => {
    expect(unionRunsByPrecedence(undefined, null)).toEqual([]);
    expect(unionRunsByPrecedence(undefined, [{ id: 'e1' }])).toHaveLength(1);
    expect(unionRunsByPrecedence([{ id: 'b1' }], undefined)).toHaveLength(1);
  });
});
