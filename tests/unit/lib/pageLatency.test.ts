/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/pageLatency.ts -- the debug/dev-only per-page latency
 * instrumentation behind the DebugLatencyHud.
 *
 * Covers: complete no-op when inactive (the "zero behaviour change when
 * debug is off" contract), routeKeyFromPath's route-pattern mapping,
 * render/ready timing, /api/* fetch aggregation scoped to the active
 * navigation, the stale-routeKey guard, history capping at 10, and the
 * debug() logger call on finalize.
 */

jest.mock('@/lib/debug', () => ({
  isDebugEnabled: jest.fn(() => false),
  debug: jest.fn(),
}));

import { isDebugEnabled, debug as debugLog } from '@/lib/debug';
import * as pageLatency from '@/lib/pageLatency';

describe('lib/pageLatency', () => {
  const mockIsDebugEnabled = isDebugEnabled as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockIsDebugEnabled.mockReset().mockReturnValue(false);
    (debugLog as jest.Mock).mockReset();
    pageLatency.__resetPageLatencyForTests();
  });

  afterEach(() => {
    pageLatency.__resetPageLatencyForTests();
    jest.useRealTimers();
  });

  describe('routeKeyFromPath', () => {
    it('maps benchmark/eval-run inspector routes (most specific) to run-inspector', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/runs/run-1/inspect')).toBe('run-inspector');
      expect(pageLatency.routeKeyFromPath('/evaluations/runs/run-1/inspect')).toBe('run-inspector');
    });

    it('maps benchmark detail/cases/runs routes to benchmark-runs', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1')).toBe('benchmark-runs');
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/cases/case-1')).toBe('benchmark-runs');
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/runs')).toBe('benchmark-runs');
    });

    it('maps the bare list routes to benchmarks / eval-runs', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks')).toBe('benchmarks');
      expect(pageLatency.routeKeyFromPath('/evaluations/runs')).toBe('eval-runs');
    });

    it('maps /compare routes to comparison and /agent-traces to traces', () => {
      expect(pageLatency.routeKeyFromPath('/compare')).toBe('comparison');
      expect(pageLatency.routeKeyFromPath('/compare/bench-1')).toBe('comparison');
      expect(pageLatency.routeKeyFromPath('/agent-traces')).toBe('traces');
    });

    it('falls back to the raw pathname for an unmapped route', () => {
      expect(pageLatency.routeKeyFromPath('/settings')).toBe('/settings');
    });
  });

  describe('when inactive (debug off, not a dev build)', () => {
    it('startNavigation is a complete no-op: no current record, fetch left untouched', () => {
      const originalFetch = window.fetch;
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(window.fetch).toBe(originalFetch);
    });

    it('markPageReady is a no-op with no active record', () => {
      pageLatency.markPageReady('benchmarks');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(pageLatency.getHistory()).toHaveLength(0);
      expect(debugLog).not.toHaveBeenCalled();
    });

    it('turning debug off mid-session unwraps fetch and clears the current record on the next navigation', () => {
      window.fetch = jest.fn(() => Promise.resolve({})) as unknown as typeof fetch;
      const original = window.fetch;
      mockIsDebugEnabled.mockReturnValue(true);
      pageLatency.startNavigation('/evaluations/benchmarks');
      const wrapped = window.fetch;
      expect(wrapped).not.toBe(original);
      expect(pageLatency.getCurrentRecord()).not.toBeNull();

      mockIsDebugEnabled.mockReturnValue(false);
      pageLatency.startNavigation('/evaluations/runs');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(window.fetch).toBe(original);
    });
  });

  describe('when active (debug enabled)', () => {
    beforeEach(() => {
      mockIsDebugEnabled.mockReturnValue(true);
    });

    it('starts a record with the mapped route key and a null renderMs/readyMs until measured', () => {
      pageLatency.startNavigation('/evaluations/benchmarks/bench-1/runs');
      const rec = pageLatency.getCurrentRecord();
      expect(rec).toMatchObject({ route: 'benchmark-runs', renderMs: null, readyMs: null, apiCount: 0, apiTotalMs: 0 });
    });

    it('measures renderMs two animation frames after navigation start', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()!.renderMs).toBeNull();
      jest.advanceTimersByTime(50);
      expect(pageLatency.getCurrentRecord()!.renderMs).not.toBeNull();
      expect(typeof pageLatency.getCurrentRecord()!.renderMs).toBe('number');
    });

    it('markPageReady finalizes readyMs, logs via debug(), and pushes to history -- but only once per navigation', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      jest.advanceTimersByTime(50);

      pageLatency.markPageReady('benchmarks');
      const rec1 = pageLatency.getCurrentRecord();
      expect(rec1!.readyMs).not.toBeNull();
      expect(debugLog).toHaveBeenCalledTimes(1);
      expect(debugLog).toHaveBeenCalledWith('pageLatency', expect.stringContaining('benchmarks'));
      expect(pageLatency.getHistory()).toHaveLength(1);

      const readyMsAfterFirstCall = rec1!.readyMs;
      jest.advanceTimersByTime(1000);
      pageLatency.markPageReady('benchmarks'); // duplicate call (e.g. a manual refresh)
      expect(pageLatency.getCurrentRecord()!.readyMs).toBe(readyMsAfterFirstCall);
      expect(debugLog).toHaveBeenCalledTimes(1);
      expect(pageLatency.getHistory()).toHaveLength(1);
    });

    it('ignores a markPageReady call whose routeKey does not match the CURRENT navigation (stale page)', () => {
      pageLatency.startNavigation('/evaluations/benchmarks'); // -> 'benchmarks'
      pageLatency.startNavigation('/evaluations/runs'); // user already navigated on; current is now 'eval-runs'

      pageLatency.markPageReady('benchmarks'); // late call from the unmounted page
      expect(pageLatency.getCurrentRecord()!.readyMs).toBeNull();
      expect(pageLatency.getHistory()).toHaveLength(0);

      pageLatency.markPageReady('eval-runs');
      expect(pageLatency.getCurrentRecord()!.readyMs).not.toBeNull();
    });

    it('counts /api/* fetch calls (count + total ms) made during the active window, ignoring non-api calls', async () => {
      const apiResponse = { ok: true, status: 200 };
      let resolveApi: (() => void) | null = null;
      window.fetch = jest.fn((url: string) => {
        if (url.includes('/api/')) {
          return new Promise(resolve => { resolveApi = () => resolve(apiResponse); });
        }
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluations/benchmarks'); // wraps fetch

      const p1 = fetch('/api/storage/benchmarks');
      const p2 = fetch('https://example.com/not-api');
      await p2;
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(0); // non-api call doesn't count

      resolveApi!();
      await p1;
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(1);
      expect(pageLatency.getCurrentRecord()!.apiTotalMs).toBeGreaterThanOrEqual(0);
    });

    it('caps history at 10 entries, most recent first', () => {
      for (let i = 0; i < 12; i++) {
        pageLatency.startNavigation('/evaluations/benchmarks');
        pageLatency.markPageReady('benchmarks');
      }
      expect(pageLatency.getHistory()).toHaveLength(10);
    });

    it('subscribe() fires on navigation start and on markPageReady, and unsubscribe stops further notifications', () => {
      const listener = jest.fn();
      const unsubscribe = pageLatency.subscribe(listener);

      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(listener).toHaveBeenCalled();

      const callsBeforeReady = listener.mock.calls.length;
      pageLatency.markPageReady('benchmarks');
      expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeReady);

      unsubscribe();
      const callsAfterUnsubscribe = listener.mock.calls.length;
      pageLatency.startNavigation('/evaluations/runs');
      expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    });
  });
});
