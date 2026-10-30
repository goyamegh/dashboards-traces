/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plain-language reading of a report's checks (matcher results) for the
 * Judge Evaluation tab.
 *
 * Code-SDK tests record each `expect(...)` as a MatcherResult whose
 * `description` is the chai-style assertion text ("false to equal true") and
 * whose `errorMessage` is whatever the test author wrote, conventionally:
 *
 *   "<what was checked>: k=v (bar ≤ N), k=v (need ≥ N), … (request X, mode Y): expected false to equal true"
 *
 * The assertion text alone is unreadable ("false to equal true"); the
 * author's message is the real title and the `k=v (limit)` pairs are the real
 * evidence. This module parses that convention — defensively, anything it
 * cannot read is left as plain text — so the UI can show a title, a
 * measured-vs-limit table and a one-line verdict headline instead of the raw
 * strings. The raw strings stay available (collapsed) in the UI.
 */

import type { MatcherResult } from '@/lib/matchers/types';

export interface Measurement {
  key: string;
  value: string;
  /** Comparison operator when the message stated a limit (`≤`, `≥`, `<`, `>`, `=`). */
  op?: string;
  limit?: string;
  /** Whether the measured value satisfies the limit; undefined when no limit / not numeric. */
  ok?: boolean;
  /** `value / limit` when the limit was breached and both are numeric (e.g. 5.7 → "5.7× over"). */
  ratio?: number;
}

export interface ParsedAssertion {
  /** The author's "what was checked" label (text before the first `: `), or ''. */
  label: string;
  /** The message body after the label and before the context, when it is not just `k=v` pairs. */
  rest: string;
  measurements: Measurement[];
  /** Trailing "(request …, mode …)" style context, without parentheses. */
  context?: string;
  /** The chai clause ("false to equal true"), when present. */
  expected?: string;
}

const LIMIT_WORDS = '(?:bar|need|needs|limit|max|min|expected|threshold|target|at least|at most)';
const NUM = '[-+]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const UNIT = '(?:\\s?(?:ms|s|sec|secs|m|min|mins|h|%|chars|tokens|docs|documents|items|KB|MB|GB|k|K|x)\\b)?';

export function toNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

export function compare(value: number, op: string, limit: number): boolean {
  switch (op) {
    case '≤': case '<=': return value <= limit;
    case '<': return value < limit;
    case '≥': case '>=': return value >= limit;
    case '>': return value > limit;
    case '=': case '==': return value === limit;
    default: return value <= limit;
  }
}

/**
 * Parse one assertion message. Never throws; an unrecognised message comes
 * back as `{ label: '', measurements: [] }` so callers fall back to the raw
 * text.
 */
export function parseAssertionMessage(message: string | undefined | null): ParsedAssertion {
  if (!message || typeof message !== 'string') return { label: '', rest: '', measurements: [] };
  let text = message.trim();
  let expected: string | undefined;
  const exp = text.match(/:\s*expected\s+(.+)$/s);
  if (exp) {
    expected = exp[1].trim();
    text = text.slice(0, exp.index).trim();
  }
  let label = '';
  // Label = text before the first ": " provided it carries no `=` (a label
  // never does) — "answer present with retrieval omitted; service chose SIMPLE, documents=0 (…)"
  // has no label, "AGENTIC cost/latency within the fix bar: totalTokens=…" does.
  const colon = text.indexOf(': ');
  if (colon > 0 && !text.slice(0, colon).includes('=')) {
    label = text.slice(0, colon).trim();
    text = text.slice(colon + 2);
  }
  let context: string | undefined;
  const ctx = text.match(/\(((?:request|requestId|run|trace|session)[^()]*)\)\s*$/i);
  if (ctx) {
    context = ctx[1];
    text = text.slice(0, ctx.index).trim().replace(/[,;]\s*$/, '');
  }
  const measurements: Measurement[] = [];
  const re = new RegExp(`([A-Za-z_][\\w .\\-/]*?)\\s*=\\s*(${NUM}${UNIT}|true|false|[A-Za-z_][\\w\\-]*)(?:\\s*\\(${LIMIT_WORDS}\\s*([≤≥<>=]=?)\\s*(${NUM}${UNIT})\\))?`, 'g');
  for (const m of text.matchAll(re)) {
    const key = m[1].trim().replace(/^[,;]\s*/, '');
    if (!key) continue;
    const value = m[2].trim();
    const meas: Measurement = { key, value };
    if (m[3] && m[4]) {
      meas.op = m[3];
      meas.limit = m[4].trim();
      const v = toNumber(value);
      const l = toNumber(meas.limit);
      if (v !== undefined && l !== undefined) {
        meas.ok = compare(v, meas.op, l);
        if (!meas.ok && l !== 0) meas.ratio = v / l;
      }
    } else if (value === 'true' || value === 'false') {
      // Booleans named like a failure ("refusal=true") read as bad; leave `ok` unset otherwise.
      if (/refus|error|fail|timeout|missing|empty/i.test(key)) meas.ok = value === 'false';
    }
    measurements.push(meas);
  }
  // No "<label>: …" structure: the whole narrative IS the label
  // ("answer present with retrieval omitted; service chose SIMPLE, documents=0")
  // — unless it is just chai's own clause ("expected 47320 to be below 30000"),
  // which is not an author label.
  if (!label && text && !/^expected\s/i.test(text)) { label = text; text = ''; }
  return { label, rest: text, measurements, context, expected };
}

/** The runner's synthetic "later matchers never ran" marker (services/evaluation appendNotReachedMarker). */
export function isNotReachedMarker(m: Pick<MatcherResult, 'notReached' | 'description'>): boolean {
  return !!m.notReached || /^Test body did not complete/.test(m.description || '');
}

/**
 * Human title for a check row: the author's label when the message has one,
 * else the assertion text. The not-reached marker gets a short fixed title.
 */
export function checkTitle(m: Pick<MatcherResult, 'description' | 'errorMessage' | 'notReached'>): string {
  if (isNotReachedMarker(m)) return 'Later checks did not run';
  const parsed = parseAssertionMessage(m.errorMessage);
  return parsed.label || m.description || '(check)';
}

/** One-line evidence for a check: "totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s". */
export function checkEvidence(m: Pick<MatcherResult, 'errorMessage' | 'description' | 'notReached'>): string {
  if (isNotReachedMarker(m)) return '';
  const parsed = parseAssertionMessage(m.errorMessage);
  const bad = parsed.measurements.filter(x => x.ok === false);
  const shown = bad.length ? bad : parsed.measurements.filter(x => x.limit);
  if (shown.length) return shown.map(x => `${x.key} ${formatNumber(x.value)}${x.limit ? ` vs ${x.op} ${formatNumber(x.limit)}` : ''}`).join(' · ');
  // Nothing numeric to compare — the author's own words after the label
  // ("retrieval_paths=[filter-only:3, lexical:16] from 87 spans").
  return parsed.rest.length > 200 ? `${parsed.rest.slice(0, 199)}…` : parsed.rest;
}

export function formatNumber(s: string): string {
  const n = toNumber(s);
  if (n === undefined) return s;
  const unit = s.replace(/[-+\d.,\s]/g, '');
  const num = Number.isInteger(n) ? n.toLocaleString('en-US') : String(n);
  return unit ? `${num} ${unit}` : num;
}

export function formatRatio(r: number | undefined): string {
  if (r === undefined || !Number.isFinite(r)) return '';
  if (r >= 1) return `${r >= 10 ? Math.round(r) : r.toFixed(1)}× over`;
  return `${Math.round((1 - r) * 100)}% short`;
}

export interface ChecksSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  notReached: number;
  notApplicable: number;
  llmJudgeCalls: number;
}

export function summarizeChecks(results: MatcherResult[] | undefined): ChecksSummary {
  const list = Array.isArray(results) ? results : [];
  const s: ChecksSummary = { total: 0, passed: 0, failed: 0, errored: 0, notReached: 0, notApplicable: 0, llmJudgeCalls: 0 };
  for (const m of list) {
    if (isNotReachedMarker(m)) { s.notReached++; continue; }
    if (m.notApplicable) { s.notApplicable++; continue; }
    s.total++;
    if (m.method === 'llm-judge') s.llmJudgeCalls++;
    if (m.errored) s.errored++;
    else if (m.pass) s.passed++;
    else s.failed++;
  }
  return s;
}

/** Collapse a judge's prose into its first sentence (markdown stripped). */
export function firstSentence(text: string | undefined, max = 200): string {
  const t = String(text || '').replace(/[*#`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface JudgementHeadline {
  tone: 'passed' | 'failed' | 'errored' | 'pending';
  /** e.g. "FAILED — cost/latency within the fix bar: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s" */
  title: string;
  /** e.g. "Decided by 2 code checks written in the test (no LLM judge): 1 passed, 1 failed, 1 not reached." */
  how: string;
}

/**
 * The one line a reader needs: the verdict and what decided it. Built only
 * from the report's own fields (never from a model).
 */
export function buildJudgementHeadline(report: {
  passFailStatus?: string | null;
  metricsStatus?: string;
  failureStage?: string;
  matcherResults?: MatcherResult[];
  llmJudgeReasoning?: string;
  judgeProvider?: string;
  error?: string;
}): JudgementHeadline {
  const s = summarizeChecks(report.matcherResults);
  const errored = report.metricsStatus === 'error' || report.failureStage === 'agent' || report.failureStage === 'judge' || report.failureStage === 'trace';
  if (errored) {
    const stage = report.failureStage === 'agent' ? 'the agent request failed' : report.failureStage === 'trace' ? 'traces could not be collected' : 'the judge could not produce a verdict';
    return { tone: 'errored', title: `Not judged — ${stage}`, how: report.error ? firstSentence(report.error, 240) : 'No checks ran, so no metrics were recorded (not zeros).' };
  }
  if (report.passFailStatus !== 'passed' && report.passFailStatus !== 'failed') {
    return { tone: 'pending', title: 'No verdict yet', how: 'The judgement has not completed for this report.' };
  }
  const passed = report.passFailStatus === 'passed';
  const noLlm = s.llmJudgeCalls === 0 && (report.judgeProvider === 'none' || !report.llmJudgeReasoning);
  const parts: string[] = [];
  if (s.total) {
    parts.push(`${s.passed} passed`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (s.errored) parts.push(`${s.errored} could not be evaluated`);
    if (s.notReached) parts.push(`${s.notReached} not reached`);
    if (s.notApplicable) parts.push(`${s.notApplicable} n/a`);
  }
  const judgeKind = s.total === 0
    ? (noLlm ? 'No checks were recorded.' : 'Decided by the LLM judge.')
    : noLlm
      ? `Decided by ${s.total} code check${s.total === 1 ? '' : 's'} written in the test (no LLM judge): ${parts.join(', ')}.`
      : s.llmJudgeCalls === s.total
        ? `Decided by the LLM judge (${s.total} judge call${s.total === 1 ? '' : 's'}): ${parts.join(', ')}.`
        : `Decided by ${s.total} checks — ${s.total - s.llmJudgeCalls} deterministic + ${s.llmJudgeCalls} LLM judge: ${parts.join(', ')}.`;

  if (passed) {
    return { tone: 'passed', title: s.total ? `PASSED — all ${s.total} check${s.total === 1 ? '' : 's'} passed` : 'PASSED', how: judgeKind };
  }
  // Failed: name the failing checks with their evidence.
  const failing = (report.matcherResults || []).filter(m => !isNotReachedMarker(m) && !m.notApplicable && !m.pass);
  const bits = failing.slice(0, 2).map(m => {
    if (m.method === 'llm-judge') {
      // Prefer the judge's own Summary/Verdict section when its prose has
      // headings; otherwise its first sentence.
      const sections = splitReasoningSections(m.reasoning);
      const pick = sections.find(sec => /summary|verdict|conclusion/i.test(sec.title)) || sections[0];
      const body = (pick?.body || m.errorMessage || '').replace(/^\s*(?:\*\*[^*\n]+\*\*:?|#{1,4}\s[^\n]+)\s*/, '');
      const why = firstSentence(body, 160);
      return why ? `judge: ${why.replace(/\.$/, '')}` : 'LLM judge failed it';
    }
    const title = checkTitle(m);
    const ev = checkEvidence(m);
    const shortEv = ev.length > 120 ? `${ev.slice(0, 119)}…` : ev;
    return shortEv ? `${title.replace(/\.$/, '')}: ${shortEv}` : title;
  });
  const more = failing.length > 2 ? ` (+${failing.length - 2} more)` : '';
  const why = bits.length ? bits.join(' · ') + more : firstSentence(report.llmJudgeReasoning, 200) || 'see the checks below';
  return { tone: 'failed', title: `FAILED — ${why}`, how: judgeKind };
}

/**
 * Split judge prose into sections by bold heading lines
 * ("**Fact Precision Analysis:**") so long reasoning reads as a table of
 * contents. Text with fewer than two headings is returned as one section.
 */
export function splitReasoningSections(text: string | undefined): Array<{ title: string; body: string }> {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out: Array<{ title: string; body: string[] }> = [];
  let cur = { title: '', body: [] as string[] };
  for (const line of lines) {
    const m = line.match(/^\s*(?:#{1,4}\s+(.+?)\s*:?\s*|\*\*(.+?):?\*\*:?\s*)$/);
    if (m) {
      if (cur.body.join('').trim() || cur.title) out.push(cur);
      cur = { title: (m[1] || m[2]).trim().replace(/\s+Analysis$/i, ''), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join('').trim() || cur.title) out.push(cur);
  const sections = out.map(s => ({ title: s.title, body: s.body.join('\n').trim() })).filter(s => s.body || s.title);
  if (sections.filter(s => s.title).length < 2) return [{ title: '', body: String(text || '').trim() }];
  return sections;
}
