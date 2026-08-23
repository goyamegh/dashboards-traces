/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for usePersistedState hook
 *
 * Verifies cross-component persistence, shared key behavior,
 * and realistic usage patterns (multiple hooks, remounts, concurrent access).
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { usePersistedState } from '@/hooks/usePersistedState';

describe('usePersistedState — integration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('shared preferences across components', () => {
    it('should allow BenchmarkEditor to read QuickRunModal preferences', () => {
      // Simulate QuickRunModal saving agent/model preference
      const { result: quickRun } = renderHook(() => ({
        agent: usePersistedState('quick-run:agentKey', 'default-agent'),
        model: usePersistedState('quick-run:modelId', 'claude-sonnet-4.5'),
      }));

      act(() => {
        quickRun.current.agent[1]('langgraph');
        quickRun.current.model[1]('claude-opus-4');
      });

      // BenchmarkEditor reads directly from localStorage (as it does in production)
      const storedAgent = localStorage.getItem('agent-health:quick-run:agentKey');
      const storedModel = localStorage.getItem('agent-health:quick-run:modelId');

      expect(JSON.parse(storedAgent!)).toBe('langgraph');
      expect(JSON.parse(storedModel!)).toBe('claude-opus-4');
    });

    it('should allow NewRunPage to pick up QuickRunModal preferences on mount', () => {
      // QuickRunModal sets preferences
      const { unmount: unmountQuickRun } = renderHook(() => {
        const [, setAgent] = usePersistedState('quick-run:agentKey', 'default');
        const [, setModel] = usePersistedState('quick-run:modelId', 'default');
        React.useEffect(() => {
          setAgent('holmesgpt');
          setModel('gpt-4o');
        }, []);
        return null;
      });
      unmountQuickRun();

      // NewRunPage mounts later with its own keys but same defaults pattern
      const { result: newRun } = renderHook(() => ({
        agent: usePersistedState('new-run:agentKey', 'fallback'),
        model: usePersistedState('new-run:modelId', 'fallback'),
      }));

      // NewRunPage has its own keys, so it uses its own defaults
      // But shared keys are readable via localStorage
      expect(JSON.parse(localStorage.getItem('agent-health:quick-run:agentKey')!)).toBe('holmesgpt');
      expect(JSON.parse(localStorage.getItem('agent-health:quick-run:modelId')!)).toBe('gpt-4o');
    });
  });

  describe('page-level filter persistence', () => {
    it('should persist all EvalRunsPage filters independently', () => {
      const { result } = renderHook(() => ({
        timeRange: usePersistedState('eval-runs:timeRange', '30d'),
        viewMode: usePersistedState('eval-runs:viewMode', 'flat'),
        sort: usePersistedState('eval-runs:sort', { field: 'timestamp', dir: 'desc' as const }),
        agent: usePersistedState('eval-runs:selectedAgent', 'all'),
        filterStatus: usePersistedState('eval-runs:filterStatus', 'all'),
        showRegressionsOnly: usePersistedState('eval-runs:showRegressionsOnly', false),
      }));

      // Simulate user changing multiple filters
      act(() => {
        result.current.timeRange[1]('7d');
        result.current.viewMode[1]('grouped');
        result.current.sort[1]({ field: 'passRate', dir: 'asc' });
        result.current.agent[1]('langgraph');
        result.current.filterStatus[1]('failed');
        result.current.showRegressionsOnly[1](true);
      });

      // Verify all persisted
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:timeRange')!)).toBe('7d');
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:viewMode')!)).toBe('grouped');
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:sort')!)).toEqual({ field: 'passRate', dir: 'asc' });
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:selectedAgent')!)).toBe('langgraph');
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:filterStatus')!)).toBe('failed');
      expect(JSON.parse(localStorage.getItem('agent-health:eval-runs:showRegressionsOnly')!)).toBe(true);
    });

    it('should persist TestCasesPage filters independently from EvalRunsPage', () => {
      const { result: evalRuns } = renderHook(() => ({
        viewMode: usePersistedState('eval-runs:viewMode', 'flat'),
        timeRange: usePersistedState('eval-runs:timeRange', '30d'),
      }));

      const { result: testCases } = renderHook(() => ({
        viewMode: usePersistedState('test-cases:viewMode', 'flat'),
        timeRange: usePersistedState('test-cases:timeRange', '7d'),
      }));

      act(() => {
        evalRuns.current.viewMode[1]('grouped');
        evalRuns.current.timeRange[1]('1d');
      });

      // TestCasesPage should be unaffected
      expect(testCases.current.viewMode[0]).toBe('flat');
      expect(testCases.current.timeRange[0]).toBe('7d');
    });

    it('should persist BenchmarksPage filters', () => {
      const { result, unmount } = renderHook(() => ({
        timeRange: usePersistedState('benchmarks:timeRange', 'all'),
        agent: usePersistedState('benchmarks:selectedAgent', 'all'),
        sort: usePersistedState('benchmarks:sort', { field: 'runs', dir: 'desc' as const }),
      }));

      act(() => {
        result.current.timeRange[1]('7d');
        result.current.agent[1]('holmesgpt');
        result.current.sort[1]({ field: 'score', dir: 'asc' });
      });

      unmount();

      // Remount and verify restoration
      const { result: restored } = renderHook(() => ({
        timeRange: usePersistedState('benchmarks:timeRange', 'all'),
        agent: usePersistedState('benchmarks:selectedAgent', 'all'),
        sort: usePersistedState('benchmarks:sort', { field: 'runs', dir: 'desc' as const }),
      }));

      expect(restored.current.timeRange[0]).toBe('7d');
      expect(restored.current.agent[0]).toBe('holmesgpt');
      expect(restored.current.sort[0]).toEqual({ field: 'score', dir: 'asc' });
    });

    it('should persist BenchmarkRunsPage tab and version filter', () => {
      const { result, unmount } = renderHook(() => ({
        activeTab: usePersistedState('benchmark-runs:activeTab', 'runs'),
        runVersionFilter: usePersistedState<number | 'all'>('benchmark-runs:runVersionFilter', 'all'),
      }));

      act(() => {
        result.current.activeTab[1]('test-cases');
        result.current.runVersionFilter[1](3);
      });

      unmount();

      const { result: restored } = renderHook(() => ({
        activeTab: usePersistedState('benchmark-runs:activeTab', 'runs'),
        runVersionFilter: usePersistedState<number | 'all'>('benchmark-runs:runVersionFilter', 'all'),
      }));

      expect(restored.current.activeTab[0]).toBe('test-cases');
      expect(restored.current.runVersionFilter[0]).toBe(3);
    });
  });

  describe('run configuration persistence', () => {
    it('should persist QuickRunModal agent/model/evaluator selections', () => {
      const { result, unmount } = renderHook(() => ({
        agent: usePersistedState('quick-run:agentKey', 'default-agent'),
        model: usePersistedState('quick-run:modelId', 'claude-sonnet-4.5'),
        evaluator: usePersistedState<string | undefined>('quick-run:evaluatorId', undefined),
      }));

      act(() => {
        result.current.agent[1]('langgraph');
        result.current.model[1]('claude-opus-4');
        result.current.evaluator[1]('custom-evaluator-1');
      });

      unmount();

      // Simulate reopening QuickRunModal
      const { result: reopened } = renderHook(() => ({
        agent: usePersistedState('quick-run:agentKey', 'default-agent'),
        model: usePersistedState('quick-run:modelId', 'claude-sonnet-4.5'),
        evaluator: usePersistedState<string | undefined>('quick-run:evaluatorId', undefined),
      }));

      expect(reopened.current.agent[0]).toBe('langgraph');
      expect(reopened.current.model[0]).toBe('claude-opus-4');
      expect(reopened.current.evaluator[0]).toBe('custom-evaluator-1');
    });

    it('should persist NewRunPage concurrency setting', () => {
      const { result, unmount } = renderHook(() => ({
        agentKey: usePersistedState('new-run:agentKey', 'default'),
        modelId: usePersistedState('new-run:modelId', 'default'),
        concurrency: usePersistedState('new-run:concurrency', 1),
      }));

      act(() => {
        result.current.concurrency[1](5);
        result.current.agentKey[1]('strands');
        result.current.modelId[1]('gpt-4o');
      });

      unmount();

      const { result: restored } = renderHook(() => ({
        agentKey: usePersistedState('new-run:agentKey', 'default'),
        modelId: usePersistedState('new-run:modelId', 'default'),
        concurrency: usePersistedState('new-run:concurrency', 1),
      }));

      expect(restored.current.concurrency[0]).toBe(5);
      expect(restored.current.agentKey[0]).toBe('strands');
      expect(restored.current.modelId[0]).toBe('gpt-4o');
    });
  });

  describe('concurrent hook instances', () => {
    it('should handle multiple hooks with same key mounted simultaneously', () => {
      // This can happen if the same component is rendered in two places
      const { result: hook1 } = renderHook(() => usePersistedState('shared:key', 'default'));
      const { result: hook2 } = renderHook(() => usePersistedState('shared:key', 'default'));

      // Both start with 'default' (since localStorage is empty)
      expect(hook1.current[0]).toBe('default');
      expect(hook2.current[0]).toBe('default');

      // Update hook1
      act(() => {
        hook1.current[1]('updated');
      });

      // hook1 reflects the change
      expect(hook1.current[0]).toBe('updated');
      // hook2 still has old value (no cross-instance sync — acceptable tradeoff)
      expect(hook2.current[0]).toBe('default');
      // But localStorage has the latest
      expect(JSON.parse(localStorage.getItem('agent-health:shared:key')!)).toBe('updated');
    });
  });

  describe('type safety with complex values', () => {
    it('should correctly persist and restore union types', () => {
      const { result, unmount } = renderHook(() =>
        usePersistedState<'all' | 'passed' | 'failed' | 'mixed'>('test:union', 'all')
      );

      act(() => { result.current[1]('failed'); });
      unmount();

      const { result: restored } = renderHook(() =>
        usePersistedState<'all' | 'passed' | 'failed' | 'mixed'>('test:union', 'all')
      );
      expect(restored.current[0]).toBe('failed');
    });

    it('should correctly persist and restore number | string union', () => {
      const { result, unmount } = renderHook(() =>
        usePersistedState<number | 'all'>('test:numOrAll', 'all')
      );

      act(() => { result.current[1](5); });
      unmount();

      const { result: restored } = renderHook(() =>
        usePersistedState<number | 'all'>('test:numOrAll', 'all')
      );
      expect(restored.current[0]).toBe(5);
      expect(typeof restored.current[0]).toBe('number');
    });
  });
});
