/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-page latency instrumentation, active ONLY when debug mode is enabled
 * (see lib/debug.ts) or this is a dev build (`import.meta.env.DEV`). When
 * neither is true every exported function is a no-op: no timers, no
 * `fetch` wrapping, no state kept — zero behaviour change for normal users.
 *
 * Lifecycle of one "navigation" record:
 *   1. `startNavigation(pathname)` — called by the top-level Layout on every
 *      route change. Maps the pathname to a stable route key (so dynamic
 *      segments like a benchmark id don't fragment the same page into many
 *      distinct routes), stamps `startedAt`, and schedules a first-render
 *      timestamp two animation frames out (paint has happened by then).
 *   2. `markPageReady(routeKey)` — a one-line call each instrumented page
 *      makes once its own primary data fetch(es) settle. `routeKey` must be
 *      the SAME key `routeKeyFromPath` produces for that page's route (a
 *      literal, e.g. 'benchmark-runs') — this is the guard against a slow
 *      page finalizing a LATER navigation's record after the user already
 *      moved on: markPageReady is a no-op unless it still matches the
 *      currently active navigation.
 *   3. While a navigation is active, `window.fetch` calls to `/api/*` are
 *      counted (count + total ms) into whichever record was current WHEN
 *      THE CALL STARTED (not whichever is current when it resolves -- a
 *      slow request must count against the page that made it, not
 *      whichever page the user has since navigated to), and only until
 *      that record is finalized by `markPageReady` (a background
 *      poll/refresh firing after "ready" must not keep inflating a number
 *      already reported as final) or `isPageLatencyActive()` goes false
 *      (so toggling debug off stops polluting the hidden record even
 *      before the next navigation gets a chance to actually restore
 *      `window.fetch`).
 *
 * Finalized records are pushed to a capped (10) history and logged via the
 * existing `debug()` logger so they land in the console/server debug log.
 *
 * The HUD's expanded view also surfaces the named operation timings recorded
 * through `lib/performance.ts` (`startMeasure` / `endMeasure`, e.g.
 * `TraceFlowView.preprocessing`) -- the data the former PerformanceOverlay
 * displayed. `getOperationStats()` groups them per name into avg / min / max /
 * count, `classifyDuration()` applies the same 🟢 < 50 ms · 🟡 < 200 ms ·
 * 🔴 ≥ 200 ms bands, and `subscribe()` fires on new measurements too.
 */

import { isDebugEnabled, debug } from './debug';
import { isViteDev } from '@/lib/viteEnv';
import {
  getMetrics,
  clearMetrics,
  subscribeToMetrics,
  startMeasure,
  endMeasure,
  logSummary,
} from './performance';

export interface PageLatencyRecord {
  /** Stable route key (see {@link routeKeyFromPath}), NOT the raw pathname. */
  route: string;
  /** Epoch ms (Date.now()) when the navigation started — for history ordering/display. */
  startedAt: number;
  /** ms from navigation start to first render (2 animation frames), or null until measured. */
  renderMs: number | null;
  /** ms from navigation start to the page reporting itself ready, or null until markPageReady. */
  readyMs: number | null;
  /** Count of `/api/*` fetch() calls observed during this navigation's window. */
  apiCount: number;
  /** Total ms spent in those fetch() calls (wall time, calls may overlap). */
  apiTotalMs: number;
}

const HISTORY_CAP = 10;

/** Per-operation aggregate of `lib/performance` measurements (one row in the HUD's expanded view). */
export interface OperationStat {
  /** Full measurement name, e.g. `TraceFlowView.preprocessing`. */
  name: string;
  /** Last dotted segment (`preprocessing`) -- the row's headline. */
  label: string;
  /** Everything before the last segment (`TraceFlowView`), '' if undotted. */
  group: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  count: number;
}

/** Duration band used for colour-coding: fast < 50 ms, ok < 200 ms, else slow. */
export type DurationBand = 'fast' | 'ok' | 'slow';

export function classifyDuration(ms: number): DurationBand {
  if (ms < 50) return 'fast';
  if (ms < 200) return 'ok';
  return 'slow';
}

/**
 * Groups every recorded `lib/performance` measurement by name into
 * avg / min / max / count, sorted slowest-average first (same aggregation
 * the former PerformanceOverlay rendered). `totalMeasurements` is the raw
 * sample count across all names.
 */
export function getOperationStats(): { stats: OperationStat[]; totalMeasurements: number } {
  const metrics = getMetrics();
  const byName = new Map<string, number[]>();
  for (const m of metrics) {
    const list = byName.get(m.name);
    if (list) list.push(m.duration);
    else byName.set(m.name, [m.duration]);
  }
  const stats: OperationStat[] = [];
  byName.forEach((durations, name) => {
    const dot = name.lastIndexOf('.');
    stats.push({
      name,
      label: dot === -1 ? name : name.slice(dot + 1),
      group: dot === -1 ? '' : name.slice(0, dot),
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      count: durations.length,
    });
  });
  stats.sort((a, b) => b.avgMs - a.avgMs);
  return { stats, totalMeasurements: metrics.length };
}

/** Drops every recorded operation measurement (the HUD's "Clear" button). */
export function clearOperationStats(): void {
  clearMetrics();
}

let current: PageLatencyRecord | null = null;
let currentStartPerf = 0; // performance.now() at navigation start (monotonic, for accurate deltas)
const history: PageLatencyRecord[] = [];

type Listener = () => void;
let listeners: Listener[] = [];

let fetchWrapped = false;
let originalFetch: typeof fetch | null = null;

/** Route-pattern → stable key. Order matters: most specific patterns first. */
const ROUTE_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/^\/evaluations\/benchmarks\/[^/]+\/runs\/[^/]+\/inspect\/?$/, 'run-inspector'],
  [/^\/evaluations\/runs\/[^/]+\/inspect\/?$/, 'run-inspector'],
  [/^\/evaluations\/benchmarks\/[^/]+(\/cases\/[^/]+)?(\/runs)?\/?$/, 'benchmark-runs'],
  [/^\/evaluations\/benchmarks\/?$/, 'benchmarks'],
  [/^\/evaluations\/runs\/?$/, 'eval-runs'],
  [/^\/compare(\/[^/]+)?\/?$/, 'comparison'],
  [/^\/agent-traces\/?$/, 'traces'],
];

/** Maps a raw pathname to the stable key instrumented pages call `markPageReady` with. */
export function routeKeyFromPath(pathname: string): string {
  for (const [pattern, key] of ROUTE_KEY_PATTERNS) {
    if (pattern.test(pathname)) return key;
  }
  return pathname;
}

function isDevBuild(): boolean {
  return isViteDev();
}

/**
 * The pre-HUD PerformanceOverlay was switched on by setting
 * `localStorage.DEBUG_PERFORMANCE = 'true'` from the browser console (still
 * documented, and still written by the Settings debug toggle) -- keep that
 * path working for the merged HUD.
 */
function isLegacyPerfFlagSet(): boolean {
  try {
    return typeof window !== 'undefined' && localStorage.getItem('DEBUG_PERFORMANCE') === 'true';
  } catch {
    return false;
  }
}

/** Whether instrumentation should be doing ANYTHING right now. */
export function isPageLatencyActive(): boolean {
  return isDebugEnabled() || isDevBuild() || isLegacyPerfFlagSet();
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Subscribe to record updates (navigation start / render / api / ready) AND
 * to `lib/performance` measurement changes. Returns an unsubscribe fn.
 */
export function subscribe(fn: Listener): () => void {
  listeners.push(fn);
  const unsubscribeMetrics = subscribeToMetrics(fn);
  return () => {
    listeners = listeners.filter(l => l !== fn);
    unsubscribeMetrics();
  };
}

/**
 * Console API (`window.__agentHealthPerf`) for ad-hoc `startMeasure` /
 * `endMeasure` timings from DevTools that then show up in the HUD. The HUD
 * exposes it while it is active and removes it when it deactivates (its
 * lifecycle is the HUD's activation, not a navigation).
 */
const CONSOLE_API_KEY = '__agentHealthPerf';

export function exposeConsoleApi(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[CONSOLE_API_KEY]) return;
  w[CONSOLE_API_KEY] = {
    startMeasure,
    endMeasure,
    getMetrics,
    getOperationStats,
    clearMetrics,
    logSummary,
  };
}

export function removeConsoleApi(): void {
  if (typeof window === 'undefined') return;
  delete (window as unknown as Record<string, unknown>)[CONSOLE_API_KEY];
}

function apiUrlFrom(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request object
  return (input as Request).url || '';
}

function wrapFetch(): void {
  if (fetchWrapped || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  originalFetch = window.fetch;
  const boundOriginal = originalFetch.bind(window);
  const wrapped: typeof fetch = async (...args: Parameters<typeof fetch>) => {
    const url = apiUrlFrom(args[0]);
    const isApiCall = url.includes('/api/');
    // Attribute to whichever navigation is active WHEN THE CALL STARTS, not
    // whichever is active when it resolves -- a slow request started on
    // page A that resolves after the user has already navigated to page B
    // must count against A's window, not silently pollute B's (codex_review
    // finding). Captured once, up front, deliberately NOT re-read from the
    // mutable module-level `current` inside `finally`.
    const recordAtCallStart = current;
    const t0 = performance.now();
    try {
      return await boundOriginal(...args);
    } finally {
      // Also stop counting once the record has been finalized (markPageReady
      // already fired) -- a background poll/refresh firing after "ready"
      // must not keep inflating a number the HUD already reported as final
      // -- and once debug/dev mode is turned off, even before the NEXT
      // navigation gets a chance to actually unwrap `window.fetch` (both
      // codex_review findings).
      if (isApiCall && recordAtCallStart && recordAtCallStart.readyMs === null && isPageLatencyActive()) {
        recordAtCallStart.apiCount += 1;
        recordAtCallStart.apiTotalMs += Math.round(performance.now() - t0);
        notify();
      }
    }
  };
  window.fetch = wrapped;
  fetchWrapped = true;
}

function unwrapFetch(): void {
  if (fetchWrapped && originalFetch && typeof window !== 'undefined') {
    window.fetch = originalFetch;
  }
  fetchWrapped = false;
  originalFetch = null;
}

/**
 * Called on every route change (Layout). No-op (and unwraps `fetch` if it
 * was previously wrapped) when instrumentation isn't active — e.g. the user
 * just turned debug mode off.
 */
export function startNavigation(pathname: string): void {
  if (!isPageLatencyActive()) {
    current = null;
    unwrapFetch();
    return;
  }
  wrapFetch();
  const route = routeKeyFromPath(pathname);
  currentStartPerf = performance.now();
  current = {
    route,
    startedAt: Date.now(),
    renderMs: null,
    readyMs: null,
    apiCount: 0,
    apiTotalMs: 0,
  };
  const record = current;
  if (typeof requestAnimationFrame === 'function') {
    // Two frames: the first fires before the browser has necessarily
    // painted the just-committed DOM; by the second, paint has happened.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (current === record && record.renderMs === null) {
          record.renderMs = Math.round(performance.now() - currentStartPerf);
          notify();
        }
      });
    });
  }
  notify();
}

/**
 * One-line call an instrumented page makes once its primary load resolves.
 * `routeKey` must match what {@link routeKeyFromPath} produces for that
 * page's route — a mismatch (stale call from a page the user has since
 * navigated away from) is silently ignored, and a record is only finalized
 * once (a page calling this more than once, e.g. on a manual refresh
 * button, doesn't corrupt history with duplicates).
 */
export function markPageReady(routeKey: string): void {
  if (!isPageLatencyActive() || !current) return;
  if (current.route !== routeKey) return;
  if (current.readyMs !== null) return;
  // Render is measured 2 animation frames after navigation start; by the
  // time a page's primary data load resolves that has virtually always
  // already fired, but finalize it here too (rather than leaving it a
  // permanent "—" in this record's history entry) for the rare case a page
  // reports ready before its own first paint has been observed.
  if (current.renderMs === null) {
    current.renderMs = Math.round(performance.now() - currentStartPerf);
  }
  current.readyMs = Math.round(performance.now() - currentStartPerf);
  debug(
    'pageLatency',
    `${current.route} · render ${current.renderMs ?? '—'} ms · ready ${current.readyMs} ms · ${current.apiCount} api / ${current.apiTotalMs} ms`,
  );
  history.unshift({ ...current });
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
  notify();
}

/** The in-progress (or last-started) navigation's record, or null. */
export function getCurrentRecord(): PageLatencyRecord | null {
  return current;
}

/** Finalized navigations, most recent first, capped at 10. */
export function getHistory(): PageLatencyRecord[] {
  return history;
}

/** Test-only: reset all module state (records, history, fetch wrapping, listeners). */
export function __resetPageLatencyForTests(): void {
  current = null;
  currentStartPerf = 0;
  history.length = 0;
  unwrapFetch();
  removeConsoleApi();
  clearMetrics();
  listeners = [];
}
