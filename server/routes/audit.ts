/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Audit Routes — "did my agent ever do something it shouldn't have?" (Flow 3).
 *
 * `POST /api/audit/query` accepts an AuditRule, compiles it to an OpenSearch
 * query via `buildAuditQuery`, runs it against the spans index, and returns the
 * matching spans (the offending traces). This is the search-problem framing
 * from the POD roadmap: at PB scale, "every trace where the agent called the
 * Refund tool on an enterprise customer but the judge scored below 2" is a
 * query, not a scan — and it reads the same `gen_ai.*` trace facts every other
 * surface uses, so there is no parallel data model.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getObservabilityClient } from '../services/observabilityClient.js';
import { buildAuditQuery, otelSpanFieldMapper, type AuditRule } from '@/services/audit';

const router = Router();

const MAX_HITS = 200;

/**
 * POST /api/audit/query
 * Body: { rule: AuditRule, size?: number }
 * 200 → { ruleId, total, hits: Span[] }
 * 400 → invalid rule (incl. condition-less rule, which buildAuditQuery rejects)
 * 502 → observability query failed · 503 → no observability cluster
 */
router.post('/api/audit/query', async (req: Request, res: Response) => {
  const { rule, size } = req.body ?? {};

  if (!rule || typeof rule !== 'object' || typeof (rule as AuditRule).id !== 'string') {
    return res.status(400).json({ error: 'rule (with a string id) is required' });
  }
  const limit = Number.isInteger(size) && size > 0 && size <= MAX_HITS ? size : 50;

  // Compile the rule against the OTel span index field layout
  // (`span.attributes.<key with . -> @>`). buildAuditQuery throws on a
  // condition-less rule (refusing a full-index scan) — surface that as a 400.
  let query: { query: Record<string, unknown> };
  try {
    query = buildAuditQuery(rule as AuditRule, otelSpanFieldMapper);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid audit rule' });
  }

  const obs = getObservabilityClient(req);
  if (!obs) {
    return res.status(503).json({
      error: 'No observability cluster configured. Set up telemetry (see: agent-health setup-telemetry).',
    });
  }

  try {
    const result: any = await obs.client.search({
      index: obs.indexes.traces,
      body: { ...query, size: limit },
    });
    const hitsRaw = result?.body?.hits?.hits ?? result?.hits?.hits ?? [];
    const totalRaw = result?.body?.hits?.total ?? result?.hits?.total;
    const total = typeof totalRaw === 'object' ? totalRaw?.value : totalRaw;
    return res.json({
      ruleId: (rule as AuditRule).id,
      total: total ?? hitsRaw.length,
      hits: hitsRaw.map((h: any) => h._source ?? h),
    });
  } catch (err: any) {
    debug('AuditAPI', 'search failed:', err?.message);
    return res.status(502).json({ error: `Audit query failed: ${err?.message ?? String(err)}` });
  }
});

export default router;
