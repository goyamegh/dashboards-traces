/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for usePersistedState with a DYNAMIC key.
 *
 * The bug (codex review of #415, finding 1): the hook read localStorage only
 * in the useState initializer, so when the key changed between renders —
 * e.g. `filter:${benchmarkId}` while client-side navigating from benchmark A
 * to benchmark B without a component remount — the in-memory value from A's
 * key survived, B's stored value was never read, and the next set() wrote
 * A's stale value under B's key (cross-entity state leakage).
 */

import { renderHook, act } from '@testing-library/react';
import { usePersistedState } from '@/hooks/usePersistedState';

describe('usePersistedState — dynamic keys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rehydrates from the new key when the key changes between renders', () => {
    localStorage.setItem('agent-health:filter:bench-a', JSON.stringify(8));
    localStorage.setItem('agent-health:filter:bench-b', JSON.stringify('all'));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => usePersistedState<number | 'all'>(`filter:${id}`, 'all'),
      { initialProps: { id: 'bench-a' } }
    );
    expect(result.current[0]).toBe(8);

    // Client-side navigation: same component instance, new key.
    rerender({ id: 'bench-b' });
    expect(result.current[0]).toBe('all'); // B's own value, NOT A's leaked 8
  });

  it('falls back to the default when the new key has no stored value', () => {
    localStorage.setItem('agent-health:filter:bench-a', JSON.stringify(8));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => usePersistedState<number | 'all'>(`filter:${id}`, 'all'),
      { initialProps: { id: 'bench-a' } }
    );
    expect(result.current[0]).toBe(8);

    rerender({ id: 'bench-fresh' });
    expect(result.current[0]).toBe('all');
  });

  it('writes to the CURRENT key after a key change, never the old one', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => usePersistedState<number | 'all'>(`filter:${id}`, 'all'),
      { initialProps: { id: 'bench-a' } }
    );

    rerender({ id: 'bench-b' });
    act(() => { result.current[1](3); });

    expect(localStorage.getItem('agent-health:filter:bench-b')).toBe(JSON.stringify(3));
    expect(localStorage.getItem('agent-health:filter:bench-a')).toBeNull();
  });

  it('keeps normal single-key behavior intact (read, set, persist)', () => {
    const { result } = renderHook(() => usePersistedState<string>('static-key', 'default'));
    expect(result.current[0]).toBe('default');
    act(() => { result.current[1]('changed'); });
    expect(result.current[0]).toBe('changed');
    expect(localStorage.getItem('agent-health:static-key')).toBe(JSON.stringify('changed'));
  });
});
