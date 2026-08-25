/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ComparisonDeepDive — the top-level "what's actually different" panel for an
 * N-run (2–4) comparison.
 *
 * Calls POST /api/comparison/deep-dive with one representative report per run
 * PLUS the shared-case verdict matrix (id, name, per-run verdicts + durations
 * + report ids). The server compresses the matrix into a deterministic prompt
 * prefix (agreement partition, per-category pass rates, split/all-fail
 * one-liners) and runs an in-process pi agent with read-only trace tools over
 * ALL runs, returning a concise markdown deep-dive citing specific spans as
 * `[label](span:<runId>:<spanId>)`. We render the markdown and turn those span
 * citations into clickable pills that deep-link into the Traces tab of the
 * relevant run + test case on the same page (via onSpanLink).
 *
 * The agent run is ~30-60s and costs tokens, so results are cached in-memory by
 * the report-id tuple; the panel auto-runs once per tuple and offers a
 * regenerate.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Loader2, RefreshCw, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BenchmarkRun, EvaluationReport, TestCaseComparisonRow } from '@/types';
import { sanitizeMarkdownUrl } from './sanitizeMarkdownUrl';

export interface DeepDiveRunMeta {
  key: string;
  reportId: string;
  runId?: string;
  serviceName?: string;
  startedAt: number;
  endedAt: number;
  /** Which test case this report belongs to (representative or focus case). */
  testCaseId?: string;
}
interface DeepDiveResponse {
  markdown: string;
  modelId: string;
  durationMs: number;
  runs: DeepDiveRunMeta[];
}

interface CacheEntry { markdown: string; meta: DeepDiveResponse; }

// The agentic deep-dive is expensive (runs an in-process agent over the
// compared runs' spans/logs), so we cache the result. Reports are immutable,
// so the key (the report-id tuple) is stable forever — the cache is backed by
// localStorage so a page reload / re-navigation shows the prior result
// INSTANTLY instead of re-running the agent and showing the loading spinner
// every single time.
const DEEPDIVE_CACHE_PREFIX = 'agent-health:deepdive:';
const deepDiveMemCache = new Map<string, CacheEntry>();

const deepDiveCache = {
  has(key: string): boolean {
    if (deepDiveMemCache.has(key)) return true;
    try { return localStorage.getItem(DEEPDIVE_CACHE_PREFIX + key) !== null; } catch { return false; }
  },
  get(key: string): CacheEntry | undefined {
    const mem = deepDiveMemCache.get(key);
    if (mem) return mem;
    try {
      const raw = localStorage.getItem(DEEPDIVE_CACHE_PREFIX + key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as CacheEntry;
      deepDiveMemCache.set(key, entry);
      return entry;
    } catch { return undefined; }
  },
  set(key: string, entry: CacheEntry): void {
    deepDiveMemCache.set(key, entry);
    try { localStorage.setItem(DEEPDIVE_CACHE_PREFIX + key, JSON.stringify(entry)); } catch { /* quota/unavailable: mem cache still serves this session */ }
  },
};

interface ComparisonDeepDiveProps {
  runs: BenchmarkRun[];
  rows: TestCaseComparisonRow[];
  reports: Record<string, EvaluationReport>;
  getAgentName: (key: string) => string;
  /** Click a span citation → deep-link into the Traces tab of that run. */
  onSpanLink: (testCaseId: string, runId: string, spanId: string) => void;
  /** Resolved window-agent hints (serviceName + window) so the Traces tab can render spans. */
  onWindowAgents: (meta: DeepDiveRunMeta[]) => void;
}

export const MAX_DEEPDIVE_RUNS = 4;

/** Badge palette per run key (A/B/C/D). */
const KEY_BADGE_CLASSES = [
  'bg-opensearch-blue/15 text-opensearch-blue border-opensearch-blue/40',
  'bg-purple-500/20 text-purple-300 border-purple-400/40',
  'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
  'bg-amber-500/20 text-amber-300 border-amber-400/40',
];
const keyIndex = (key: string) => Math.max(0, key.toUpperCase().charCodeAt(0) - 65);

export const ComparisonDeepDive: React.FC<ComparisonDeepDiveProps> = ({
  runs,
  rows,
  reports,
  getAgentName,
  onSpanLink,
  onWindowAgents,
}) => {
  // Representative tuple: the first test case ALL compared runs executed.
  const group = useMemo(() => {
    if (runs.length < 2 || runs.length > MAX_DEEPDIVE_RUNS) return null;
    for (const row of rows) {
      const ids = runs.map((run) => row.results[run.id]?.reportId);
      if (ids.every((id): id is string => Boolean(id))) {
        return {
          testCaseId: row.testCaseId,
          testCaseName: row.testCaseName,
          reportIds: ids,
          cacheKey: ids.join('|'),
        };
      }
    }
    return null;
  }, [runs, rows]);

  // Shared-case verdict matrix — the server compresses this into the
  // deterministic prompt prefix (partition / category rates / focus cases).
  const casesPayload = useMemo(() => {
    if (runs.length < 2) return [];
    return rows
      .filter((row) => runs.every((run) => row.results[run.id]?.reportId))
      .map((row) => ({
        id: row.testCaseId,
        name: row.testCaseName,
        verdicts: runs.map((run) => {
          const result = row.results[run.id];
          if (!result || result.status === 'missing') return 'missing';
          if (result.errored || result.status === 'failed') return 'error';
          if (result.passFailStatus === 'passed') return 'pass';
          if (result.passFailStatus === 'failed') return 'fail';
          return 'error';
        }),
        durationsMs: runs.map((run) => {
          const reportId = row.results[run.id]?.reportId;
          const duration = reportId ? reports[reportId]?.performanceMetrics?.durationMs : undefined;
          return typeof duration === 'number' ? duration : null;
        }),
        reportIds: runs.map((run) => row.results[run.id]?.reportId ?? null),
      }));
  }, [rows, runs, reports]);

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [markdown, setMarkdown] = useState<string>('');
  const [meta, setMeta] = useState<DeepDiveResponse | null>(null);
  const [error, setError] = useState<string>('');

  const generate = useCallback(
    async (force = false) => {
      if (!group) return;
      if (!force && deepDiveCache.has(group.cacheKey)) {
        const c = deepDiveCache.get(group.cacheKey)!;
        setMarkdown(c.markdown);
        setMeta(c.meta);
        setStatus('done');
        onWindowAgents(c.meta.runs || []);
        return;
      }
      setStatus('loading');
      setError('');
      try {
        const res = await fetch('/api/comparison/deep-dive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reportIds: group.reportIds, cases: casesPayload }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${res.status}`);
        }
        const data: DeepDiveResponse = await res.json();
        deepDiveCache.set(group.cacheKey, { markdown: data.markdown, meta: data });
        setMarkdown(data.markdown);
        setMeta(data);
        setStatus('done');
        onWindowAgents(data.runs || []);
      } catch (e: any) {
        setError(e?.message || String(e));
        setStatus('error');
      }
    },
    [group, casesPayload, onWindowAgents]
  );

  // Auto-run once per report tuple.
  useEffect(() => {
    if (group) generate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.cacheKey]);

  // Map a cited runId → which agent label (for nicer pill titles).
  const labelByRunId = useMemo(() => {
    const m = new Map<string, string>();
    (meta?.runs || []).forEach((r) => {
      if (r.runId) m.set(r.runId, getAgentName(runs[keyIndex(r.key)]?.agentKey) || r.key);
    });
    return m;
  }, [meta, runs, getAgentName]);

  if (!group) return null;

  // Key → run mapping follows the URL order (A = runs[0], B = runs[1], …).
  // Surface it everywhere — header + span-citation pills — so a
  // `span:subprocess-…` citation is unambiguous about which run it belongs to.
  const keyByRunId = new Map<string, string>();
  const caseByRunId = new Map<string, string>();
  (meta?.runs || []).forEach((r) => {
    if (!r.runId) return;
    keyByRunId.set(r.runId, r.key);
    if (r.testCaseId) caseByRunId.set(r.runId, r.testCaseId);
  });
  const KeyBadge = ({ k, className = '' }: { k: string; className?: string }) => (
    <span className={`inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[0.7rem] font-bold border ${KEY_BADGE_CLASSES[keyIndex(k) % KEY_BADGE_CLASSES.length]} ${className}`}>{k}</span>
  );

  // Custom anchor: `span:<runId>:<spanId>` → deep-link pill; others → normal link.
  const SpanAnchor = ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const m = /^span:([^:]+):(.+)$/.exec(href || '');
    if (m) {
      const [, runId, spanId] = m;
      const who = labelByRunId.get(runId);
      return (
        <button
          type="button"
          data-span-id={spanId}
          data-run-id={runId}
          onClick={() => onSpanLink(caseByRunId.get(runId) ?? group.testCaseId, runId, spanId)}
          title={`Open this span in the Traces tab${who ? ` (${who})` : ''}`}
          className="inline-flex items-center gap-0.5 align-baseline rounded bg-opensearch-blue/10 px-1.5 py-0.5 text-[0.85em] font-medium text-opensearch-blue hover:bg-opensearch-blue/20 transition-colors"
        >
          {keyByRunId.get(runId) && <span className="font-bold opacity-80">{keyByRunId.get(runId)}·</span>}
          {children}
          <ArrowUpRight size={11} className="flex-shrink-0" />
        </button>
      );
    }
    return (
      // `href` is already sanitized by ReactMarkdown's urlTransform
      // (sanitizeMarkdownUrl): dangerous schemes have been dropped to ''. Guard
      // anyway — render unsafe/empty links as plain text, never a live anchor.
      href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-opensearch-blue hover:underline">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4" data-testid="comparison-deep-dive">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={16} className="text-opensearch-blue flex-shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">What's actually different</h3>
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              {runs.map((run, i) => (
                <React.Fragment key={run.id}>
                  {i > 0 && <span className="opacity-60">vs</span>}
                  <KeyBadge k={String.fromCharCode(65 + i)} /> {getAgentName(run.agentKey)}
                </React.Fragment>
              ))}
              <span className="opacity-60">· grounded in all {runs.length} runs' traces</span>
            </p>
          </div>
        </div>
        {status === 'done' && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs flex-shrink-0" onClick={() => generate(true)}>
            <RefreshCw size={12} /> Regenerate
          </Button>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />
          Inspecting all {runs.length} runs' spans &amp; logs…
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-start gap-2 py-3 text-sm text-amber-400">
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p>Couldn't generate the deep-dive: {error}</p>
            <Button variant="outline" size="sm" className="h-7 mt-2 text-xs" onClick={() => generate(true)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {status === 'done' && (
        <>
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5 [&_strong]:text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={sanitizeMarkdownUrl} components={{ a: SpanAnchor }}>
              {markdown}
            </ReactMarkdown>
          </div>
          {meta && (
            <p className="text-[10px] text-muted-foreground/70 mt-3 pt-2 border-t border-border">
              Generated by {meta.modelId.split('/').pop()} in {(meta.durationMs / 1000).toFixed(0)}s · click a
              highlighted span to open it in the Traces tab below
            </p>
          )}
        </>
      )}
    </div>
  );
};
