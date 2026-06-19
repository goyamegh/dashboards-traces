/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capsule Routes — record a trace-anchored capsule from a real session.
 *
 * `POST /api/capsules/from-session` fetches a session's OTel spans and
 * assembles a content-addressed Capsule (the *record* half — see
 * services/capsules/buildCapsule.ts). This makes Flow 2 reachable over HTTP on
 * the same server as Profile (Flow 1) and Audit (Flow 3); the record/replay
 * middleware that freezes external I/O is the next layer on top of this.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getObservabilityClient } from '../services/observabilityClient.js';
import { fetchTraces } from '../services/tracesService.js';
import { buildCapsule } from '@/services/capsules';
import type { Span } from '@/types';

const router = Router();

const MAX_SESSION_SPANS = 2000;

/**
 * POST /api/capsules/from-session
 * Body: { sessionId, testCaseId, agent, rev, model?, service? }
 * 200 → Capsule · 400 → bad input · 404 → no spans · 502/503 → observability
 */
router.post('/api/capsules/from-session', async (req: Request, res: Response) => {
  const { sessionId, testCaseId, agent, rev, model } = req.body ?? {};

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId (string) is required' });
  }
  if (typeof testCaseId !== 'string' || !testCaseId.trim()) {
    return res.status(400).json({ error: 'testCaseId (string) is required' });
  }
  if (typeof agent !== 'string' || typeof rev !== 'string') {
    return res.status(400).json({ error: 'agent and rev (strings) are required' });
  }

  const obs = getObservabilityClient(req);
  if (!obs) {
    return res.status(503).json({
      error: 'No observability cluster configured. Set up telemetry (see: agent-health setup-telemetry).',
    });
  }

  let spans: Span[];
  try {
    const result = await fetchTraces({ sessionId, size: MAX_SESSION_SPANS }, obs.client, obs.indexes.traces);
    spans = (result.spans || []) as Span[];
  } catch (err: any) {
    debug('CapsuleAPI', 'fetchTraces failed:', err?.message);
    return res.status(502).json({ error: `Failed to fetch session traces: ${err?.message ?? String(err)}` });
  }

  if (spans.length === 0) {
    return res.status(404).json({ error: `No spans found for session ${sessionId}.`, sessionId });
  }

  try {
    const capsule = buildCapsule({ testCaseId, spans, agent, rev, model });
    return res.json(capsule);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Failed to build capsule' });
  }
});

export default router;
