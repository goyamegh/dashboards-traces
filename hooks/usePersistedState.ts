/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef } from 'react';

const STORAGE_PREFIX = 'agent-health:';

function readFromStorage<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function writeToStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

/**
 * Drop-in replacement for useState that persists the value to localStorage.
 * Key is automatically prefixed with 'agent-health:'.
 *
 * Usage:
 *   const [timeRange, setTimeRange] = usePersistedState('eval-runs:timeRange', '30d');
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => readFromStorage(key, defaultValue));
  const keyRef = useRef(key);
  keyRef.current = key;

  const setPersistedState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
        writeToStorage(keyRef.current, next);
        return next;
      });
    },
    []
  );

  return [state, setPersistedState];
}
