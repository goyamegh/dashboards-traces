/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Best-effort extraction of structure from LLM-judge *reasoning prose*.
 *
 * The durable contract for structured judge output is `judgeExtraFields`
 * (facts / failure_causes / evidence emitted as JSON by the judge prompt and
 * captured by `server/services/judgeResponseParser.ts`). But the large body
 * of already-persisted verdicts — and every evaluator whose prompt hasn't
 * been upgraded — carries this information only inside the free-form
 * `reasoning` string. Judges reliably write recognizable shapes there:
 *
 *   1. 'You can start accepting payments almost immediately' — PARTIALLY stated. …
 *   **Fact 1: Voucher is not visible at checkout.** — FULLY STATED. …
 *   Required fact 1 ('can start accepting payments'): FULLY STATED — …
 *   The expected source document is article 49d9e88f… However, the agent
 *   retrieved a different article (b6c9353c…)
 *
 * These parsers are deliberately conservative: they return nothing rather
 * than guess, and the UI treats their output as an *annotation* on top of
 * the verbatim reasoning (which stays available), never a replacement.
 * Structured `judgeExtraFields` always wins over a parse when present.
 */

export type FactVerdictKind = 'stated' | 'partial' | 'missing' | 'contradicted';

export interface ParsedFactVerdict {
  /** The required fact / claim text as the judge quoted it. */
  fact: string;
  verdict: FactVerdictKind;
  /** Trailing judge note for this fact, when one directly follows. */
  note?: string;
}

export interface ParsedSourceMismatch {
  /** Doc/article id the test expected the agent to cite (truncated ok). */
  expected: string;
  /** Doc/article id the agent actually cited/retrieved. */
  cited: string;
}

/** Map a matched verdict keyword onto the canonical kind. */
function verdictKind(keyword: string): FactVerdictKind {
  const k = keyword.toUpperCase();
  if (k.includes('CONTRADICT') && !k.includes('MISSING')) return 'contradicted';
  if (k.includes('MISSING') || k.includes('NOT STATED')) return 'missing';
  if (k.includes('PARTIAL')) return 'partial';
  return 'stated';
}

// Verdict keywords the judge writes inline after a fact. Order matters:
// longest / most specific first so "MISSING/CONTRADICTED" isn't split.
const VERDICT_KEYWORD =
  /(MISSING\s*\/\s*CONTRADICTED|FULLY\s+STATED|PARTIALLY\s+STATED|NOT\s+STATED|CONTRADICTED|MISSING|PARTIAL(?:LY)?)/i;

// Parse at most this much reasoning — real verdicts are a few KB; a hard cap
// bounds regex work on pathological inputs (defense against backtracking
// blowups on adversarial multi-hundred-KB strings).
const MAX_PARSE_CHARS = 20_000;

// A fact item: list marker (`1.`, `1)`, `**Fact 1:`, `Required fact 1 (`),
// then the fact text (quoted or plain), a separator (—, -, :, en-dash, `):`),
// then the verdict keyword. Fact text is capped to keep matches sane.
// NOTE: deliberately no lookbehind — constructed-at-import regexes with
// lookbehind hard-crash report rendering on older WebKit. The leading
// whitespace/newline is consumed instead (harmless: markers never overlap).
const FACT_ITEM = new RegExp(
  String.raw`(?:^|[\s\n])` + // start of string or after whitespace (inline numbered lists)
    String.raw`(?:\*\*)?(?:Required\s+fact\s+\d+|Fact\s+\d+|\d+)\s*[.):\u2013\u2014-]?\s*` + // marker
    String.raw`(?:\*\*)?\s*` +
    String.raw`['‘"“(]?(.{4,240}?)['’"”)]?` + // fact text (lazy)
    String.raw`(?:\*\*)?\s*[\u2013\u2014:(\u2015-]+\s*(?:\*\*)?\s*` + // separator
    VERDICT_KEYWORD.source + // verdict
    String.raw`(?:\s+stated)?` + // "PARTIALLY stated"
    String.raw`[.!]?\s*` +
    // Trailing note: lazy, stopped by the NEXT numbered/bold fact item on the
    // same line (inline lists put every fact in one paragraph) or line end.
    String.raw`([^\n]*?)(?=\s\d+[.)]\s*['‘"“(*]|\s\*\*(?:Required\s+fact|Fact)|\n|$)`,
  'gi'
);

/**
 * Extract per-required-fact verdicts from judge reasoning prose.
 * Returns `[]` when nothing that looks like a fact list is present —
 * callers must fall back to showing the raw reasoning.
 */
export function parseFactVerdicts(reasoning: string | undefined): ParsedFactVerdict[] {
  if (!reasoning || reasoning.length < 20) return [];
  const text = reasoning.slice(0, MAX_PARSE_CHARS);
  const out: ParsedFactVerdict[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(FACT_ITEM)) {
    const factRaw = (m[1] ?? '').trim();
    const keyword = m[2] ?? '';
    // Guard against summary-phrase false positives like
    // "4 facts fully stated (1.0 each)": require real fact text, not a
    // recap that itself talks about facts/statements in aggregate.
    if (!factRaw || factRaw.length < 8) continue;
    if (/^facts?\b/i.test(factRaw) || /\bfacts fully stated\b/i.test(factRaw)) continue;
    // Strip markdown/bold leftovers and trailing separators.
    const fact = factRaw.replace(/\*\*/g, '').replace(/[\u2013\u2014:-]+$/, '').trim();
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let note = (m[3] ?? '').replace(/\*\*/g, '').trim().slice(0, 220);
    // Notes that are just the start of the next list item are noise.
    if (/^\d+[.)]/.test(note)) note = '';
    out.push({ fact, verdict: verdictKind(keyword), ...(note ? { note } : {}) });
    if (out.length >= 12) break; // sanity cap
  }
  return out;
}

// Hex-ish document/article ids (8+ chars, at least one a–f so bare integers
// like "10000000" never qualify) — what RAG corpora and judge reasoning use
// when naming expected vs cited sources.
const HEX_ID_SCAN = /\b(?=[0-9]*[a-f])[0-9a-f]{8,64}\b/i;

/** First hex id within `window` chars after `index` in `text`, if any. */
function firstIdAfter(text: string, index: number, window = 140): string | undefined {
  const m = text.slice(index, index + window).match(HEX_ID_SCAN);
  return m?.[0];
}

/**
 * Detect an "expected source X but cited/retrieved Y" statement.
 * Conservative: both ids must be present and differ.
 */
export function parseSourceMismatch(reasoning: string | undefined): ParsedSourceMismatch | null {
  if (!reasoning) return null;
  const text = reasoning.slice(0, MAX_PARSE_CHARS);

  // Expected id: first hex id shortly after an "expected source …" mention.
  // (A character-class "gap" can't work here — prose like "document is
  // article" contains hex letters — so scan a window for the first id.)
  const expectedKw = text.match(/expected\s+source\s+(?:document|article)?/i);
  if (!expectedKw || expectedKw.index === undefined) return null;
  const expected = firstIdAfter(text, expectedKw.index + expectedKw[0].length);
  if (!expected) return null;

  // Cited id: first differing hex id shortly after a cite/retrieve verb.
  const citedKw = /(?:\bcited\b|\bretrieved\b|\busing\s+article\b|\bcites\b)/gi;
  for (const m of text.matchAll(citedKw)) {
    if (m.index === undefined) continue;
    const id = firstIdAfter(text, m.index + m[0].length);
    if (id && id.toLowerCase() !== expected.toLowerCase()) {
      return { expected, cited: id };
    }
  }

  // Compact form: "(b6c9353c vs 49d9e88f)" — either order relative to expected.
  const vs = text.match(
    new RegExp(String.raw`([0-9a-f]{8,64})\s*(?:vs\.?|versus)\s*([0-9a-f]{8,64})`, 'i')
  );
  if (vs) {
    const [a, b] = [vs[1], vs[2]];
    const other = a.toLowerCase() === expected.toLowerCase() ? b : a;
    if (other && other.toLowerCase() !== expected.toLowerCase()) {
      return { expected, cited: other };
    }
  }
  return null;
}

/** Shorten a long doc id for display: `49d9e88fadbf…` (first 8 chars). */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
