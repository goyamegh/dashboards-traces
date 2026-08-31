/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the judge-reasoning prose parsers.
 *
 * The three long fixtures are VERBATIM reasoning strings persisted by real
 * runs of the `logos-human-persona` evaluator (wixqa smoke run) — the parsers
 * must handle exactly what real judges write, not idealized shapes.
 */

import {
  parseFactVerdicts,
  parseSourceMismatch,
  shortId,
} from '@/lib/matchers/judgeReasoningParse';

// Real reasoning #1 — inline numbered facts, single paragraph, PARTIALLY ×2.
const REASONING_PAYMENTS = `The gold answer is simple: yes, you can start accepting payments almost immediately during verification, but full activation requires identity verification. The expected source document is article 49d9e88fadbf11fa4e685c847590078ff9394c2fe7566094f504f53ca4aca465. However, the agent retrieved a different article (b6c9353c0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5 — 'Wix Payments: Understanding the Status of Your Account') and built its answer from that document. Required facts evaluation: 1. 'You can start accepting payments almost immediately' — PARTIALLY stated. The agent says yes you can accept payments, but frames it around an 'Accepting Payments' status with caveats, rather than the simple 'almost immediately' framing of the gold answer. 2. 'Identity verification needed before full activation' — PARTIALLY stated. The agent mentions verification/setup completion, but the specific framing of 'verify your identity' is not clearly stated. answer_correctness calculation: 2 required facts, both partially stated = (0.5 + 0.5) / 2 * 100 = 50. Score: 55. trust_honesty: Score: 45.`;

// Real reasoning #2 — newline-separated numbered facts, MISSING/CONTRADICTED.
const REASONING_DRAFT = `The gold answer specifies that to make published changes draft, you edit your site in the Wix Editor, save your changes, and simply do NOT click Publish — this keeps changes as a draft. The expected source document is article 359dab9e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5 which is about the Wix Editor draft/publish workflow for site pages.

Required facts evaluation:
1. 'Edit your site and save without clicking Publish to keep changes as draft' — MISSING/CONTRADICTED. The agent answered a completely different question: how to revert a Wix Blog post to draft status.

The agent's answer describes the Wix Blog 'Revert to Draft' feature using article 6c922e650a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5 instead of the correct article 359dab9e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5. answer_correctness = 0/1 required facts = 0%.`;

// Real reasoning #3 — markdown bold **Fact N:** items, mixed verdicts, and a
// recap sentence ("4 facts fully stated (1.0 each)") that must NOT parse as a fact.
const REASONING_VOUCHER = `Let me evaluate each required fact individually:

**Fact 1: Voucher is not visible at checkout; becomes available after completing the purchase.** — FULLY STATED. The answer clearly states 'it does not appear at checkout' and 'Find your voucher after purchase.' (1.0)

**Fact 2: Claim the voucher via the Premium Vouchers page in your Wix account.** — FULLY STATED. The answer explicitly says 'go to the Premium Vouchers page in your Wix account.' (1.0)

**Fact 3: Voucher is valid for two months from date of purchase.** — FULLY STATED. The answer correctly states 'valid for two months from your plan purchase date.' (1.0)

**Fact 4: Voucher allows registering a domain free for one year.** — FULLY STATED. 'claim a free domain for one year' is mentioned. (1.0)

**Fact 5: Eligibility criteria note / If issues persist, contact Wix Customer Care.** — MISSING. The gold answer specifically mentions contacting Wix Customer Care. (0.5 partial)

**Source document:** The expected source document ID is 06535db983ea0ffe0214af14497a1d158f279d92c92f211e87b8820aa95dbe43, but the agent cited 3e86e4683b655df0208424aeda336b4d0afa8f1aafa0ad4c6fa2baed9610bada. This is a DIFFERENT article entirely.

**answer_correctness calculation:** 4 facts fully stated (1.0 each) + 1 partial (0.5) = 4.5/5 = 90%.`;

describe('parseFactVerdicts', () => {
  it('parses inline single-paragraph numbered facts (payments case)', () => {
    const facts = parseFactVerdicts(REASONING_PAYMENTS);
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toContain('accepting payments almost immediately');
    expect(facts[0].verdict).toBe('partial');
    expect(facts[1].fact).toContain('Identity verification');
    expect(facts[1].verdict).toBe('partial');
  });

  it('parses MISSING/CONTRADICTED (draft case)', () => {
    const facts = parseFactVerdicts(REASONING_DRAFT);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toContain('without clicking Publish');
    expect(facts[0].verdict).toBe('missing');
  });

  it('parses markdown **Fact N:** items and skips the recap sentence (voucher case)', () => {
    const facts = parseFactVerdicts(REASONING_VOUCHER);
    expect(facts).toHaveLength(5);
    expect(facts.map(f => f.verdict)).toEqual([
      'stated', 'stated', 'stated', 'stated', 'missing',
    ]);
    expect(facts[0].fact).toContain('not visible at checkout');
    expect(facts[4].fact).toContain('Customer Care');
    // The "4 facts fully stated (1.0 each)" recap must not appear.
    expect(facts.some(f => /facts fully stated/i.test(f.fact))).toBe(false);
  });

  it('captures trailing notes when present', () => {
    const facts = parseFactVerdicts(REASONING_PAYMENTS);
    expect(facts[0].note).toMatch(/frames it around/);
  });

  it('returns [] for prose without a fact list', () => {
    expect(parseFactVerdicts('The answer was generally correct and complete.')).toEqual([]);
    expect(parseFactVerdicts(undefined)).toEqual([]);
    expect(parseFactVerdicts('')).toEqual([]);
  });
});

describe('parseSourceMismatch', () => {
  it('detects expected-vs-retrieved ids (payments case)', () => {
    const mm = parseSourceMismatch(REASONING_PAYMENTS);
    expect(mm).not.toBeNull();
    expect(mm!.expected.startsWith('49d9e88f')).toBe(true);
    expect(mm!.cited.startsWith('b6c9353c')).toBe(true);
  });

  it('detects expected-vs-cited ids (voucher case)', () => {
    const mm = parseSourceMismatch(REASONING_VOUCHER);
    expect(mm).not.toBeNull();
    expect(mm!.expected.startsWith('06535db9')).toBe(true);
    expect(mm!.cited.startsWith('3e86e468')).toBe(true);
  });

  it('detects mismatch in the draft case', () => {
    const mm = parseSourceMismatch(REASONING_DRAFT);
    expect(mm).not.toBeNull();
    expect(mm!.expected.startsWith('359dab9e')).toBe(true);
    expect(mm!.cited.startsWith('6c922e65')).toBe(true);
  });

  it('returns null when the agent cited the EXPECTED source (no mismatch)', () => {
    const ok = `The expected source document is article 49d9e88fadbf11fa4e685c8475900780. The citation includes the correct article ID (49d9e88fadbf11fa4e685c8475900780) matching the expected source.`;
    expect(parseSourceMismatch(ok)).toBeNull();
  });

  it('returns null without any ids', () => {
    expect(parseSourceMismatch('no ids here')).toBeNull();
    expect(parseSourceMismatch(undefined)).toBeNull();
  });
});

describe('shortId', () => {
  it('truncates long ids to 8 chars + ellipsis', () => {
    expect(shortId('49d9e88fadbf11fa4e685c847590078f')).toBe('49d9e88f…');
  });
  it('leaves short ids alone', () => {
    expect(shortId('49d9e88f')).toBe('49d9e88f');
  });
});

describe('parser robustness guards', () => {
  it('caps work on pathological multi-hundred-KB inputs (bounded parse window)', () => {
    // A huge blob of near-miss fact-list noise; must return quickly and not throw.
    const noise = `1. 'almost a fact but no verdict keyword here at all' — maybe. `.repeat(8000);
    const start = Date.now();
    const facts = parseFactVerdicts(noise);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(Array.isArray(facts)).toBe(true);
  });

  it('ignores fact-like text beyond the parse window', () => {
    const pad = 'x'.repeat(25_000);
    const tail = ` 1. 'a fact stated after the cap' — MISSING.`;
    expect(parseFactVerdicts(pad + tail)).toEqual([]);
  });
});

describe('parseSourceMismatch — compact "vs" form', () => {
  it('resolves the cited id from "(cited vs expected)" when no cite-verb precedes it', () => {
    const r = `The expected source document is article 49d9e88fabcd1234. The answer was built from the wrong document (b6c9353c9999abcd vs 49d9e88fabcd1234).`;
    const mm = parseSourceMismatch(r);
    expect(mm).not.toBeNull();
    expect(mm!.expected).toBe('49d9e88fabcd1234');
    expect(mm!.cited).toBe('b6c9353c9999abcd');
  });

  it('returns null when the vs-pair is the expected id on both sides', () => {
    const r = `The expected source document is article 49d9e88fabcd1234 (49d9e88fabcd1234 vs 49d9e88fabcd1234).`;
    expect(parseSourceMismatch(r)).toBeNull();
  });
});
