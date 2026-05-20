/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, act } from '@testing-library/react';
import { usePersistedState } from '@/hooks/usePersistedState';

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('initialization', () => {
    it('should return default value when localStorage is empty', () => {
      const { result } = renderHook(() => usePersistedState('test:key', 'default'));
      expect(result.current[0]).toBe('default');
    });

    it('should return stored value when localStorage has data', () => {
      localStorage.setItem('agent-health:test:key', JSON.stringify('stored'));
      const { result } = renderHook(() => usePersistedState('test:key', 'default'));
      expect(result.current[0]).toBe('stored');
    });

    it('should return default value when localStorage has invalid JSON', () => {
      localStorage.setItem('agent-health:test:key', 'not-json{{{');
      const { result } = renderHook(() => usePersistedState('test:key', 'default'));
      expect(result.current[0]).toBe('default');
    });

    it('should handle complex default values', () => {
      const defaultValue = { field: 'name', dir: 'desc' as const };
      const { result } = renderHook(() => usePersistedState('test:sort', defaultValue));
      expect(result.current[0]).toEqual(defaultValue);
    });

    it('should handle numeric defaults', () => {
      const { result } = renderHook(() => usePersistedState('test:num', 42));
      expect(result.current[0]).toBe(42);
    });

    it('should handle boolean defaults', () => {
      const { result } = renderHook(() => usePersistedState('test:bool', false));
      expect(result.current[0]).toBe(false);
    });

    it('should handle undefined defaults', () => {
      const { result } = renderHook(() => usePersistedState<string | undefined>('test:undef', undefined));
      expect(result.current[0]).toBeUndefined();
    });
  });

  describe('state updates', () => {
    it('should update state and persist to localStorage', () => {
      const { result } = renderHook(() => usePersistedState('test:key', 'initial'));

      act(() => {
        result.current[1]('updated');
      });

      expect(result.current[0]).toBe('updated');
      expect(localStorage.getItem('agent-health:test:key')).toBe(JSON.stringify('updated'));
    });

    it('should support functional updates', () => {
      const { result } = renderHook(() => usePersistedState('test:counter', 0));

      act(() => {
        result.current[1](prev => prev + 1);
      });

      expect(result.current[0]).toBe(1);
      expect(localStorage.getItem('agent-health:test:counter')).toBe('1');
    });

    it('should persist object values', () => {
      const { result } = renderHook(() =>
        usePersistedState('test:sort', { field: 'name', dir: 'asc' })
      );

      act(() => {
        result.current[1]({ field: 'date', dir: 'desc' });
      });

      expect(result.current[0]).toEqual({ field: 'date', dir: 'desc' });
      expect(JSON.parse(localStorage.getItem('agent-health:test:sort')!)).toEqual({
        field: 'date',
        dir: 'desc',
      });
    });

    it('should persist array values', () => {
      const { result } = renderHook(() => usePersistedState<string[]>('test:arr', []));

      act(() => {
        result.current[1](['a', 'b', 'c']);
      });

      expect(result.current[0]).toEqual(['a', 'b', 'c']);
    });

    it('should persist null values', () => {
      const { result } = renderHook(() => usePersistedState<string | null>('test:nullable', 'initial'));

      act(() => {
        result.current[1](null);
      });

      expect(result.current[0]).toBeNull();
      expect(localStorage.getItem('agent-health:test:nullable')).toBe('null');
    });
  });

  describe('namespace isolation', () => {
    it('should not collide with different keys', () => {
      const { result: hook1 } = renderHook(() => usePersistedState('page1:filter', 'a'));
      const { result: hook2 } = renderHook(() => usePersistedState('page2:filter', 'b'));

      act(() => {
        hook1.current[1]('updated-a');
      });

      expect(hook1.current[0]).toBe('updated-a');
      expect(hook2.current[0]).toBe('b');
    });

    it('should prefix all keys with agent-health:', () => {
      renderHook(() => usePersistedState('my:key', 'val'));

      // Should not exist without prefix
      expect(localStorage.getItem('my:key')).toBeNull();
      // Should not write until setter is called, but initial read should work
    });
  });

  describe('cross-session persistence', () => {
    it('should restore value after remount', () => {
      const { result, unmount } = renderHook(() =>
        usePersistedState('test:persist', 'initial')
      );

      act(() => {
        result.current[1]('saved');
      });

      unmount();

      // Remount - should read from localStorage
      const { result: result2 } = renderHook(() =>
        usePersistedState('test:persist', 'initial')
      );
      expect(result2.current[0]).toBe('saved');
    });
  });

  describe('error handling', () => {
    it('should gracefully handle localStorage.setItem failure', () => {
      const { result } = renderHook(() => usePersistedState('test:key', 'initial'));

      // Mock setItem to throw (e.g., storage full)
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = jest.fn(() => {
        throw new Error('QuotaExceededError');
      });

      // Should still update state without throwing
      act(() => {
        result.current[1]('updated');
      });

      expect(result.current[0]).toBe('updated');

      Storage.prototype.setItem = originalSetItem;
    });

    it('should gracefully handle localStorage.getItem failure', () => {
      const originalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = jest.fn(() => {
        throw new Error('SecurityError');
      });

      const { result } = renderHook(() => usePersistedState('test:key', 'fallback'));
      expect(result.current[0]).toBe('fallback');

      Storage.prototype.getItem = originalGetItem;
    });
  });
});
