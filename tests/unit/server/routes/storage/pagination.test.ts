/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the shared storage-list-pagination helper
 * (server/routes/storage/pagination.ts).
 *
 * Regression coverage for the API KPI probe finding: storage list endpoints
 * ignored `limit`/invalid `size` and returned unbounded dumps. These tests
 * lock in the clamp convention so the bug class can't silently return.
 */

import { parseListPagination, parseOptionalListPagination } from '@/server/routes/storage/pagination';

describe('parseListPagination', () => {
  const LIMITS = { defaultSize: 100, maxSize: 1000 };

  it('defaults to defaultSize/0 when no params are given', () => {
    expect(parseListPagination({}, LIMITS)).toEqual({ size: 100, from: 0 });
  });

  it('respects an explicit numeric size', () => {
    expect(parseListPagination({ size: '5' }, LIMITS)).toEqual({ size: 5, from: 0 });
  });

  it('accepts `limit` as an alias for `size` — the probe used this name and it was previously ignored entirely', () => {
    expect(parseListPagination({ limit: '5' }, LIMITS)).toEqual({ size: 5, from: 0 });
  });

  it('prefers `size` over `limit` when both are present', () => {
    expect(parseListPagination({ size: '7', limit: '5' }, LIMITS)).toEqual({ size: 7, from: 0 });
  });

  it.each(['abc', '', 'NaN', '1.5x'])('clamps non-numeric size %p to defaultSize instead of falling through to "everything"', (raw) => {
    expect(parseListPagination({ size: raw }, LIMITS).size).toBe(100);
  });

  it.each(['0', '-5', '-100000'])('clamps zero/negative size %p to defaultSize', (raw) => {
    expect(parseListPagination({ size: raw }, LIMITS).size).toBe(100);
    expect(parseListPagination({ limit: raw }, LIMITS).size).toBe(100);
  });

  it('caps an oversized explicit size at maxSize (this is what actually bounds response size)', () => {
    expect(parseListPagination({ size: '100000' }, LIMITS).size).toBe(1000);
    expect(parseListPagination({ limit: '100000' }, LIMITS).size).toBe(1000);
  });

  it('floors a fractional size', () => {
    expect(parseListPagination({ size: '12.9' }, LIMITS).size).toBe(12);
  });

  it('accepts `from` and the `offset` alias', () => {
    expect(parseListPagination({ from: '20' }, LIMITS).from).toBe(20);
    expect(parseListPagination({ offset: '20' }, LIMITS).from).toBe(20);
  });

  it.each(['abc', '-1', '-100'])('clamps invalid/negative from %p to 0', (raw) => {
    expect(parseListPagination({ from: raw }, LIMITS).from).toBe(0);
  });
});

describe('parseOptionalListPagination', () => {
  const LIMITS = { defaultSize: 100, maxSize: 500 };

  it('reports paginated=false and an unbounded size when neither size nor limit is present', () => {
    const result = parseOptionalListPagination({}, LIMITS);
    expect(result.paginated).toBe(false);
    expect(result.size).toBe(Number.POSITIVE_INFINITY);
  });

  it('still clamps `from`/`offset` even when unpaginated', () => {
    expect(parseOptionalListPagination({ from: '10' }, LIMITS).from).toBe(10);
    expect(parseOptionalListPagination({ from: '-3' }, LIMITS).from).toBe(0);
  });

  it('opts into pagination the moment `size` is present, even if invalid — this is the fix for the ' +
    '"?limit=abc silently returns everything" bug: presence of the param must never be ignored', () => {
    const result = parseOptionalListPagination({ size: 'abc' }, LIMITS);
    expect(result.paginated).toBe(true);
    expect(result.size).toBe(100);
  });

  it('opts into pagination via the `limit` alias too', () => {
    const result = parseOptionalListPagination({ limit: 'abc' }, LIMITS);
    expect(result.paginated).toBe(true);
    expect(result.size).toBe(100);
  });

  it('caps an explicit huge size even in the "opt-in" path', () => {
    const result = parseOptionalListPagination({ size: '999999' }, LIMITS);
    expect(result.paginated).toBe(true);
    expect(result.size).toBe(500);
  });
});
