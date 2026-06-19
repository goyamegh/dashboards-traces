/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildAuditQuery, clauseToQuery, otelSpanFieldMapper, type AuditRule } from '@/services/audit/auditQuery';

describe('otelSpanFieldMapper', () => {
  it('maps attribute keys to span.attributes.<dotted -> @> (no .keyword; these fields are keyword-mapped)', () => {
    expect(otelSpanFieldMapper('attributes.gen_ai.tool.name')).toBe('span.attributes.gen_ai@tool@name');
    expect(otelSpanFieldMapper('attributes.agent_health.judge.score')).toBe('span.attributes.agent_health@judge@score');
  });
  it('maps status to the numeric status.code field and passes startTime through unchanged', () => {
    expect(otelSpanFieldMapper('status')).toBe('status.code');
    expect(otelSpanFieldMapper('startTime')).toBe('startTime');
  });
});

describe('buildAuditQuery with otelSpanFieldMapper (live index layout)', () => {
  it('tool_called unions over both tool-name keys the OTel index actually uses', () => {
    const { query } = buildAuditQuery(
      { id: 'bash', all: [{ type: 'tool_called', tool: 'Bash' }] },
      otelSpanFieldMapper,
    );
    expect((query.bool as any).must[0]).toEqual({
      bool: {
        should: [
          { term: { 'span.attributes.gen_ai@tool@name': 'Bash' } },
          { term: { 'span.attributes.tool_name': 'Bash' } },
        ],
        minimum_should_match: 1,
      },
    });
  });
  it('compiles judge_score range to the flattened field', () => {
    const { query } = buildAuditQuery(
      { id: 's', all: [{ type: 'judge_score', op: 'lt', value: 2 }] },
      otelSpanFieldMapper,
    );
    expect((query.bool as any).must[0]).toEqual({
      range: { 'span.attributes.agent_health@judge@score': { lt: 2 } },
    });
  });
});

describe('clauseToQuery', () => {
  it('compiles tool_called to a should-union over both tool-name keys (identity mapper)', () => {
    expect(clauseToQuery({ type: 'tool_called', tool: 'Refund' })).toEqual({
      bool: {
        should: [
          { term: { 'attributes.gen_ai.tool.name': 'Refund' } },
          { term: { 'attributes.tool_name': 'Refund' } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it('compiles judge_score to a range', () => {
    expect(clauseToQuery({ type: 'judge_score', op: 'lt', value: 2 })).toEqual({
      range: { 'attributes.agent_health.judge.score': { lt: 2 } },
    });
  });

  it('compiles attribute eq to a term and ne to must_not', () => {
    expect(clauseToQuery({ type: 'attribute', key: 'customer.tier', op: 'eq', value: 'enterprise' })).toEqual({
      term: { 'attributes.customer.tier': 'enterprise' },
    });
    expect(clauseToQuery({ type: 'attribute', key: 'customer.tier', op: 'ne', value: 'free' })).toEqual({
      bool: { must_not: [{ term: { 'attributes.customer.tier': 'free' } }] },
    });
  });

  it('compiles attribute exists and range ops', () => {
    expect(clauseToQuery({ type: 'attribute', key: 'pii.detected', op: 'exists' })).toEqual({
      exists: { field: 'attributes.pii.detected' },
    });
    expect(clauseToQuery({ type: 'attribute', key: 'cost_usd', op: 'gte', value: 1 })).toEqual({
      range: { 'attributes.cost_usd': { gte: 1 } },
    });
  });

  it('compiles span_status', () => {
    expect(clauseToQuery({ type: 'span_status', status: 'ERROR' })).toEqual({ term: { status: 'ERROR' } });
  });

  it('compiles span_status to numeric status.code under the OTel mapper', () => {
    expect(clauseToQuery({ type: 'span_status', status: 'ERROR' }, otelSpanFieldMapper)).toEqual({
      term: { 'status.code': 2 },
    });
    expect(clauseToQuery({ type: 'span_status', status: 'OK' }, otelSpanFieldMapper)).toEqual({
      term: { 'status.code': 1 },
    });
  });
});

describe('buildAuditQuery', () => {
  it('builds the canonical "Refund on enterprise customer, judge < 2, last 30d" rule', () => {
    const rule: AuditRule = {
      id: 'refund-low-score',
      name: 'Refund tool on enterprise customer with low judge score',
      window: { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-31T00:00:00.000Z' },
      all: [
        { type: 'tool_called', tool: 'Refund' },
        { type: 'attribute', key: 'customer.tier', op: 'eq', value: 'enterprise' },
        { type: 'judge_score', op: 'lt', value: 2 },
      ],
    };

    const { query } = buildAuditQuery(rule);
    expect(query).toEqual({
      bool: {
        must: [
          {
            bool: {
              should: [
                { term: { 'attributes.gen_ai.tool.name': 'Refund' } },
                { term: { 'attributes.tool_name': 'Refund' } },
              ],
              minimum_should_match: 1,
            },
          },
          { term: { 'attributes.customer.tier': 'enterprise' } },
          { range: { 'attributes.agent_health.judge.score': { lt: 2 } } },
        ],
        filter: [
          { range: { startTime: { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-31T00:00:00.000Z' } } },
        ],
      },
    });
  });

  it('maps `any` to should + minimum_should_match:1', () => {
    const { query } = buildAuditQuery({
      id: 'any-rule',
      any: [
        { type: 'span_status', status: 'ERROR' },
        { type: 'attribute', key: 'pii.detected', op: 'exists' },
      ],
    });
    expect((query.bool as any).should).toHaveLength(2);
    expect((query.bool as any).minimum_should_match).toBe(1);
  });

  it('maps `none` to must_not', () => {
    const { query } = buildAuditQuery({
      id: 'none-rule',
      none: [{ type: 'tool_called', tool: 'DangerousTool' }],
    });
    expect((query.bool as any).must_not).toEqual([
      {
        bool: {
          should: [
            { term: { 'attributes.gen_ai.tool.name': 'DangerousTool' } },
            { term: { 'attributes.tool_name': 'DangerousTool' } },
          ],
          minimum_should_match: 1,
        },
      },
    ]);
  });

  it('refuses to build a query with no conditions (no full-index scan)', () => {
    expect(() => buildAuditQuery({ id: 'empty' })).toThrow(/no conditions/i);
  });

  it('a window-only rule is allowed (time-bounded browse)', () => {
    const { query } = buildAuditQuery({ id: 'win', window: { gte: '2026-01-01T00:00:00.000Z' } });
    expect((query.bool as any).filter).toHaveLength(1);
  });

  it('is deterministic — same rule yields identical query JSON', () => {
    const rule: AuditRule = { id: 'r', all: [{ type: 'tool_called', tool: 'X' }] };
    expect(JSON.stringify(buildAuditQuery(rule))).toBe(JSON.stringify(buildAuditQuery(rule)));
  });
});
