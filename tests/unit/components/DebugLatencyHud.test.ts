/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for DebugLatencyHud -- visible only when page-latency
 * instrumentation is active AND there is a current record; hidden
 * otherwise. Hover/click reveals history.
 */

import * as React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockIsActive = jest.fn();
const mockGetCurrentRecord = jest.fn();
const mockGetHistory = jest.fn();
const mockSubscribe = jest.fn();
const mockGetOperationStats = jest.fn();
const mockClearOperationStats = jest.fn();
const mockExposeConsoleApi = jest.fn();
const mockRemoveConsoleApi = jest.fn();

jest.mock('@/lib/pageLatency', () => ({
  exposeConsoleApi: () => mockExposeConsoleApi(),
  removeConsoleApi: () => mockRemoveConsoleApi(),
  isPageLatencyActive: () => mockIsActive(),
  getCurrentRecord: () => mockGetCurrentRecord(),
  getHistory: () => mockGetHistory(),
  getOperationStats: () => mockGetOperationStats(),
  clearOperationStats: () => mockClearOperationStats(),
  classifyDuration: (ms: number) => (ms < 50 ? 'fast' : ms < 200 ? 'ok' : 'slow'),
  subscribe: (fn: () => void) => mockSubscribe(fn),
}));

const RECORD = {
  route: 'benchmarks', startedAt: 0, renderMs: 50, readyMs: 200, apiCount: 1, apiTotalMs: 20,
};
const NO_OPS = { stats: [], totalMeasurements: 0 };

import { DebugLatencyHud } from '@/components/DebugLatencyHud';

describe('DebugLatencyHud', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsActive.mockReset().mockReturnValue(false);
    mockGetCurrentRecord.mockReset().mockReturnValue(null);
    mockGetHistory.mockReset().mockReturnValue([]);
    mockSubscribe.mockReset().mockReturnValue(() => {});
    mockGetOperationStats.mockReset().mockReturnValue(NO_OPS);
    mockClearOperationStats.mockReset();
    mockExposeConsoleApi.mockReset();
    mockRemoveConsoleApi.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing when instrumentation is inactive', () => {
    const { container } = render(React.createElement(DebugLatencyHud));
    expect(container.innerHTML).toBe('');
  });

  it('renders a placeholder line when active but no navigation has been recorded yet (debug just switched on), still expandable', () => {
    mockIsActive.mockReturnValue(true);
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(hud.textContent).toContain('navigate to start measuring');
    fireEvent.click(hud);
    expect(screen.getByTestId('debug-latency-hud-operations')).toBeTruthy();
  });

  it('exposes the DevTools console API while active and removes it on deactivation/unmount', () => {
    mockIsActive.mockReturnValue(true);
    const { unmount } = render(React.createElement(DebugLatencyHud));
    expect(mockExposeConsoleApi).toHaveBeenCalledTimes(1);
    expect(mockRemoveConsoleApi).not.toHaveBeenCalled();
    unmount();
    expect(mockRemoveConsoleApi).toHaveBeenCalledTimes(1);
  });

  it('renders the current record\u2019s summary line when active with a record', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmark-runs', startedAt: Date.now(), renderMs: 120, readyMs: 840, apiCount: 6, apiTotalMs: 610,
    });
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(hud.textContent).toContain('benchmark-runs');
    expect(hud.textContent).toContain('render 120 ms');
    expect(hud.textContent).toContain('ready 840 ms');
    expect(hud.textContent).toContain('6 api / 610 ms');
  });

  it('shows an em dash for renderMs/readyMs before they are measured', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: null, readyMs: null, apiCount: 0, apiTotalMs: 0,
    });
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(hud.textContent).toContain('render \u2014');
    expect(hud.textContent).toContain('ready \u2014');
  });

  it('reveals history on hover and hides it again on mouse leave', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: 50, readyMs: 200, apiCount: 1, apiTotalMs: 20,
    });
    mockGetHistory.mockReturnValue([
      { route: 'benchmarks', startedAt: Date.now(), renderMs: 50, readyMs: 200, apiCount: 1, apiTotalMs: 20 },
      { route: 'eval-runs', startedAt: Date.now() - 1000, renderMs: 40, readyMs: 150, apiCount: 2, apiTotalMs: 40 },
    ]);
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(screen.queryByTestId('debug-latency-hud-history')).toBeNull();

    fireEvent.mouseEnter(hud);
    expect(screen.getByTestId('debug-latency-hud-history')).toBeTruthy();
    expect(screen.getByTestId('debug-latency-hud-history').textContent).toContain('eval-runs');

    fireEvent.mouseLeave(hud);
    expect(screen.queryByTestId('debug-latency-hud-history')).toBeNull();
  });

  it('polls isPageLatencyActive so a debug-mode toggle in another tab is picked up without a remount', () => {
    mockIsActive.mockReturnValue(false);
    render(React.createElement(DebugLatencyHud));
    expect(screen.queryByTestId('debug-latency-hud')).toBeNull();

    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: 10, readyMs: 20, apiCount: 0, apiTotalMs: 0,
    });
    act(() => { jest.advanceTimersByTime(1100); });
    expect(screen.getByTestId('debug-latency-hud')).toBeTruthy();
  });

  describe('expanded view (merged PerformanceOverlay metrics)', () => {
    beforeEach(() => {
      mockIsActive.mockReturnValue(true);
      mockGetCurrentRecord.mockReturnValue(RECORD);
    });

    it('click pins the panel open (and a second click unpins), independent of hover', () => {
      render(React.createElement(DebugLatencyHud));
      const hud = screen.getByTestId('debug-latency-hud');
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.click(hud);
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
      fireEvent.mouseLeave(hud); // pinned: leaving does not collapse it
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();

      fireEvent.click(hud);
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
    });

    it('holding the \u2325 / Alt key peeks at the panel; releasing (or window blur) collapses it', () => {
      render(React.createElement(DebugLatencyHud));
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.keyDown(window, { key: 'Alt' });
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
      fireEvent.keyUp(window, { key: 'Alt' });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.keyDown(window, { key: 'Alt' });
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
      fireEvent.blur(window);
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.keyDown(window, { key: 'Shift' });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
    });

    it('"hide" dismisses the HUD for the rest of the page load', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      fireEvent.click(screen.getByTestId('debug-latency-hud-hide'));
      expect(screen.queryByTestId('debug-latency-hud')).toBeNull();
      // Later record/activation updates do not resurrect it.
      act(() => { jest.advanceTimersByTime(2100); });
      expect(screen.queryByTestId('debug-latency-hud')).toBeNull();
    });

    it('ignores auto-repeated Alt keydown events (holding the key must not flicker state)', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.keyDown(window, { key: 'Alt', repeat: true });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
      fireEvent.keyDown(window, { key: 'Alt' });
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
    });

    it('shows the operations empty state (and no Clear button) when nothing has been measured', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      const ops = screen.getByTestId('debug-latency-hud-operations');
      expect(ops.textContent).toContain('Operations \u00b7 0 measurements');
      expect(ops.textContent).toContain('No operation timings yet');
      expect(ops.textContent).toContain('\u25cf < 50 ms \u00b7 \u25cf < 200 ms \u00b7 \u25cf \u2265 200 ms');
      expect(screen.queryByTestId('debug-latency-hud-clear')).toBeNull();
      expect(screen.queryAllByTestId('debug-latency-hud-op')).toHaveLength(0);
    });

    it('lists each operation with icon, label, group, avg, min\u2013max and count, colour-coded by band', () => {
      mockGetOperationStats.mockReturnValue({
        totalMeasurements: 4,
        stats: [
          { name: 'AgentTracesPage.fetchMore', label: 'fetchMore', group: 'AgentTracesPage', avgMs: 312.4, minMs: 300, maxMs: 324.8, count: 2 },
          { name: 'TraceFlowView.preprocessing', label: 'preprocessing', group: 'TraceFlowView', avgMs: 75, minMs: 60, maxMs: 90, count: 1 },
          { name: 'flat', label: 'flat', group: '', avgMs: 5, minMs: 5, maxMs: 5, count: 1 },
        ],
      });
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));

      expect(screen.getByTestId('debug-latency-hud-operations').textContent).toContain('Operations \u00b7 4 measurements');
      const rows = screen.getAllByTestId('debug-latency-hud-op');
      expect(rows).toHaveLength(3);

      expect(rows[0].textContent).toContain('\u25cf fetchMore');
      expect(rows[0].textContent).toContain('AgentTracesPage');
      expect(rows[0].textContent).toContain('312.4 ms');
      expect(rows[0].textContent).toContain('300\u2013325 \u00b7 \u00d72');
      expect(rows[0].querySelector('.text-red-400')).toBeTruthy();

      expect(rows[1].textContent).toContain('\u25cf preprocessing');
      expect(rows[1].querySelector('.text-yellow-400')).toBeTruthy();

      expect(rows[2].textContent).toContain('\u25cf flat');
      expect(rows[2].textContent).not.toContain('\u00b7 flat'); // no group suffix for undotted names
      expect(rows[2].querySelector('.text-green-400')).toBeTruthy();
    });

    it('Clear calls clearOperationStats without toggling the pinned state', () => {
      mockGetOperationStats.mockReturnValue({
        totalMeasurements: 1,
        stats: [{ name: 'a.b', label: 'b', group: 'a', avgMs: 1, minMs: 1, maxMs: 1, count: 1 }],
      });
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      fireEvent.click(screen.getByTestId('debug-latency-hud-clear'));
      expect(mockClearOperationStats).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
    });

    it('re-reads operation stats when the subscription fires (a new measurement landed)', () => {
      let notifyFn: (() => void) | null = null;
      mockSubscribe.mockImplementation((fn: () => void) => { notifyFn = fn; return () => {}; });
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      expect(screen.queryAllByTestId('debug-latency-hud-op')).toHaveLength(0);

      mockGetOperationStats.mockReturnValue({
        totalMeasurements: 1,
        stats: [{ name: 'a.b', label: 'b', group: 'a', avgMs: 1, minMs: 1, maxMs: 1, count: 1 }],
      });
      act(() => { notifyFn!(); });
      expect(screen.getAllByTestId('debug-latency-hud-op')).toHaveLength(1);
    });
  });
});
