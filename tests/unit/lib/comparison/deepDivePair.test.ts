/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pair selection for the trace-grounded deep-dive on a 3+-run compare page
 * (lib/comparison/deepDivePair.ts): defaults (oldest → A, newest → B), URL
 * round-trip, A ≠ B enforcement, and the "keep the pinned pair only while
 * both runs stay selected" rule.
 */

import {
  changeDeepDivePairSide,
  defaultDeepDivePair,
  parseDeepDivePairParam,
  resolveDeepDivePair,
  retainDeepDivePairForSelection,
  serializeDeepDivePair,
} from '@/lib/comparison/deepDivePair';

const run = (id: string, createdAt: string) => ({ id, createdAt } as any);
// Deliberately NOT in chronological selection order.
const RUNS = [run('mid', '2026-10-02T00:00:00Z'), run('newest', '2026-10-03T00:00:00Z'), run('oldest', '2026-10-01T00:00:00Z')];
const IDS = RUNS.map((r) => r.id);

describe('defaultDeepDivePair', () => {
  it('picks the oldest selected run as A (baseline) and the newest as B regardless of selection order', () => {
    expect(defaultDeepDivePair(RUNS)).toEqual(['oldest', 'newest']);
  });

  it('returns null for fewer than two runs', () => {
    expect(defaultDeepDivePair([])).toBeNull();
    expect(defaultDeepDivePair([run('only', '2026-10-01T00:00:00Z')])).toBeNull();
  });

  it('breaks ties / unparseable dates by selection order so the result is deterministic', () => {
    expect(defaultDeepDivePair([run('x', 'garbage'), run('y', 'garbage'), run('z', 'garbage')])).toEqual(['x', 'z']);
    expect(defaultDeepDivePair([run('x', '2026-10-01T00:00:00Z'), run('y', '2026-10-01T00:00:00Z')])).toEqual(['x', 'y']);
  });
});

describe('parseDeepDivePairParam / serializeDeepDivePair', () => {
  it('round-trips a valid pair', () => {
    const s = serializeDeepDivePair(['oldest', 'mid']);
    expect(s).toBe('oldest,mid');
    expect(parseDeepDivePairParam(s, IDS)).toEqual(['oldest', 'mid']);
  });

  it('rejects absent, partial, duplicate (A = B) and non-selected ids', () => {
    expect(parseDeepDivePairParam(null, IDS)).toBeNull();
    expect(parseDeepDivePairParam('', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,oldest', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,not-selected', IDS)).toBeNull();
    expect(parseDeepDivePairParam('a,b,c', ['a', 'b', 'c'])).toBeNull();
  });
});

describe('resolveDeepDivePair', () => {
  it('uses the default pair (flagged isDefault) when the URL carries nothing usable', () => {
    expect(resolveDeepDivePair(RUNS, null)).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
    expect(resolveDeepDivePair(RUNS, 'oldest,gone')).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
  });

  it('honours a valid URL pair and flags it non-default (so it does not auto-start the LLM job)', () => {
    expect(resolveDeepDivePair(RUNS, 'oldest,mid')).toEqual({ pair: ['oldest', 'mid'], isDefault: false });
    expect(resolveDeepDivePair(RUNS, 'newest,oldest')).toEqual({ pair: ['newest', 'oldest'], isDefault: false });
  });

  it('a URL pair identical to the default still counts as the default', () => {
    expect(resolveDeepDivePair(RUNS, 'oldest,newest')).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
  });

  it('returns null with fewer than two runs', () => {
    expect(resolveDeepDivePair([RUNS[0]], 'oldest,newest')).toBeNull();
  });
});

describe('changeDeepDivePairSide (A ≠ B)', () => {
  it('changes one side and leaves the other alone when there is no collision', () => {
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'B', 'mid')).toEqual(['oldest', 'mid']);
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'A', 'mid')).toEqual(['mid', 'newest']);
  });

  it('swaps instead of producing A = B when the new value collides with the other side', () => {
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'B', 'oldest')).toEqual(['newest', 'oldest']);
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'A', 'newest')).toEqual(['newest', 'oldest']);
  });
});

describe('retainDeepDivePairForSelection', () => {
  it('keeps the pinned pair while both runs stay selected and drops it otherwise', () => {
    expect(retainDeepDivePairForSelection('oldest,mid', IDS)).toBe('oldest,mid');
    expect(retainDeepDivePairForSelection('oldest,mid', ['oldest', 'newest'])).toBeUndefined();
    expect(retainDeepDivePairForSelection(null, IDS)).toBeUndefined();
  });
});
