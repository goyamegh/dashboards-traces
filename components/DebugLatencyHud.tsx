/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unobtrusive bottom-right HUD showing the current page's latency, visible
 * ONLY when debug mode is enabled, this is a dev build, or the legacy
 * `localStorage.DEBUG_PERFORMANCE` flag is set (the activation path of the
 * PerformanceOverlay this HUD replaced). It polls that rule once a second so
 * a debug-mode toggle in another tab / the Settings page is picked up
 * without a hard refresh.
 *
 * Collapsed: one line -- `route · render X ms · ready Y ms · N api / M ms`
 * (or a "navigate to start measuring" placeholder when debug mode was just
 * switched on and no navigation has happened yet). Expanded (click to pin,
 * hover or hold ⌥/Alt to peek): the last 10 navigations, plus the
 * per-operation timings recorded via `lib/performance.ts` (avg / min / max /
 * count, colour-coded dots, with the former overlay's "Clear" action) and a
 * "hide" control that dismisses the HUD until the next page load.
 */

import React, { useEffect, useState } from 'react';
import {
  isPageLatencyActive,
  getCurrentRecord,
  getHistory,
  getOperationStats,
  clearOperationStats,
  classifyDuration,
  exposeConsoleApi,
  removeConsoleApi,
  subscribe,
  type PageLatencyRecord,
  type OperationStat,
  type DurationBand,
} from '@/lib/pageLatency';

function formatRecord(r: PageLatencyRecord): string {
  const render = r.renderMs === null ? '—' : `${r.renderMs} ms`;
  const ready = r.readyMs === null ? '—' : `${r.readyMs} ms`;
  return `${r.route} · render ${render} · ready ${ready} · ${r.apiCount} api / ${r.apiTotalMs} ms`;
}

const BAND_CLASS: Record<DurationBand, string> = {
  fast: 'text-green-400',
  ok: 'text-yellow-400',
  slow: 'text-red-400',
};

const OperationRow: React.FC<{ stat: OperationStat }> = ({ stat }) => {
  const band = classifyDuration(stat.avgMs);
  return (
    <div
      data-testid="debug-latency-hud-op"
      className="flex items-baseline justify-between gap-2 truncate"
      title={stat.name}
    >
      <span className="truncate">
        <span className={BAND_CLASS[band]}>●</span> {stat.label}
        {stat.group && <span className="text-slate-500"> · {stat.group}</span>}
      </span>
      <span className="shrink-0 tabular-nums">
        <span className={BAND_CLASS[band]}>{stat.avgMs.toFixed(1)} ms</span>
        <span className="text-slate-500">
          {' '}
          {stat.minMs.toFixed(0)}–{stat.maxMs.toFixed(0)} · ×{stat.count}
        </span>
      </span>
    </div>
  );
};

export const DebugLatencyHud: React.FC = () => {
  const [active, setActive] = useState(isPageLatencyActive());
  const [current, setCurrent] = useState<PageLatencyRecord | null>(getCurrentRecord());
  const [history, setHistory] = useState<PageLatencyRecord[]>(getHistory());
  const [ops, setOps] = useState(getOperationStats());
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const expanded = pinned || hovered || altHeld;

  // Poll for the debug-mode toggle (Settings page / another tab flips
  // localStorage; import.meta.env.DEV never changes at runtime).
  useEffect(() => {
    const id = setInterval(() => setActive(isPageLatencyActive()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      setCurrent(getCurrentRecord());
      setHistory(getHistory());
      setOps(getOperationStats());
    };
    refresh();
    return subscribe(refresh);
  }, [active]);

  // DevTools console API lives exactly as long as the HUD is active.
  useEffect(() => {
    if (!active) return;
    exposeConsoleApi();
    return removeConsoleApi;
  }, [active]);

  // Hold ⌥ / Alt to peek at the expanded view without reaching for the mouse.
  // `blur` resets the flag in case the keyup is swallowed (e.g. Alt+Tab).
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !e.repeat) setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);

  if (!active || dismissed) return null;

  return (
    <div
      data-testid="debug-latency-hud"
      data-expanded={expanded ? 'true' : 'false'}
      onClick={() => setPinned(v => !v)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="fixed bottom-3 right-3 z-50 select-none"
    >
      {expanded && (
        <div
          data-testid="debug-latency-hud-panel"
          className="mb-1 w-[28rem] max-h-80 overflow-auto rounded-md border border-slate-700 bg-slate-900/95 backdrop-blur text-[10px] text-slate-200 shadow-xl p-2 space-y-2 font-mono"
        >
          <div className="flex items-center justify-between text-slate-400">
            <span>Latency HUD</span>
            <button
              type="button"
              data-testid="debug-latency-hud-hide"
              title="Hide until the next page load"
              onClick={e => {
                e.stopPropagation();
                setDismissed(true);
              }}
              className="rounded border border-slate-600 px-1 leading-4 hover:bg-slate-700"
            >
              hide
            </button>
          </div>

          {history.length > 0 && (
            <div data-testid="debug-latency-hud-history" className="space-y-1">
              <div className="text-slate-400">Last {history.length} navigations</div>
              {history.map((r, i) => (
                <div key={`${r.route}-${r.startedAt}-${i}`} className="truncate">{formatRecord(r)}</div>
              ))}
            </div>
          )}

          <div data-testid="debug-latency-hud-operations" className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">
                Operations · {ops.totalMeasurements} measurement{ops.totalMeasurements === 1 ? '' : 's'}
              </span>
              {ops.totalMeasurements > 0 && (
                <button
                  type="button"
                  data-testid="debug-latency-hud-clear"
                  onClick={e => {
                    e.stopPropagation();
                    clearOperationStats();
                  }}
                  className="rounded border border-slate-600 px-1 leading-4 hover:bg-slate-700"
                >
                  Clear
                </button>
              )}
            </div>
            {ops.stats.length === 0 ? (
              <div className="text-slate-500">
                No operation timings yet — recorded by instrumented views (e.g. Agent Traces flow view).
              </div>
            ) : (
              ops.stats.map(stat => <OperationRow key={stat.name} stat={stat} />)
            )}
            <div className="text-slate-500">
              <span className={BAND_CLASS.fast}>●</span> &lt; 50 ms · <span className={BAND_CLASS.ok}>●</span> &lt; 200 ms ·{' '}
              <span className={BAND_CLASS.slow}>●</span> ≥ 200 ms
            </div>
          </div>
        </div>
      )}
      <div className="rounded-md border border-slate-700 bg-slate-900/90 backdrop-blur text-[10px] text-slate-200 font-mono px-2 py-1 shadow-lg cursor-pointer">
        {current ? formatRecord(current) : '— · navigate to start measuring'}
      </div>
    </div>
  );
};

export default DebugLatencyHud;
