/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Profile Routes — Profile as a first-class artifact.
 *
 * `POST /api/profile` resolves the evaluator (rubric), fetches the session's
 * spans from the observability cluster, and assembles a Profile using the
 * shared `buildProfile` core. The CLI (`agent-health profile`), the UI panel,
 * and any MCP tool all consume this one endpoint, so a Profile is byte-
 * identical regardless of surface (the single-source-of-truth principle from
 * docs/ARCHITECTURE.md — all clients go through the server).
 *
 * Introduced as the "profile-as-API" half of agent profiling: PR #267 shipped
 * the engine (spansToTrajectory + scanSessionSignals) wired only into the CLI;
 * this lifts the assembly into a route so Profile becomes a queryable artifact.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getStorageModule } from '@/server/adapters';
import { getSystemEvaluatorById, isSystemEvaluatorId } from '@/server/prompts/evaluatorTemplates';
import { getObservabilityClient } from '../services/observabilityClient.js';
import { fetchTraces } from '../services/tracesService.js';
import { buildProfile } from '@/services/profile';
import type { Evaluator, Span } from '@/types';

const router = Router();

const DEFAULT_EVALUATOR_ID = 'system-rca-default';
const MAX_SESSION_SPANS = 1000;

/** Resolve an evaluator by id: system templates first, then storage backend. */
async function resolveEvaluator(evaluatorId: string): Promise<Evaluator | null> {
  if (isSystemEvaluatorId(evaluatorId)) {
    const sys = getSystemEvaluatorById(evaluatorId);
    return sys ?? null;
  }
  const storage = getStorageModule();
  if (!storage.isConfigured()) return null;
  try {
    return (await storage.evaluators.getById(evaluatorId)) ?? null;
  } catch (err) {
    debug('ProfileAPI', `evaluator lookup failed for ${evaluatorId}:`, err);
    return null;
  }
}

/**
 * POST /api/profile
 * Body: { sessionId: string, evaluatorId?: string, service?: string, userFeedback?: string }
 * 200 → AgentProfile
 * 400 → bad input · 404 → evaluator/spans not found · 503 → no observability cluster
 */
router.post('/api/profile', async (req: Request, res: Response) => {
  const { sessionId, evaluatorId, service, userFeedback } = req.body ?? {};

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId (string) is required' });
  }
  if (evaluatorId !== undefined && typeof evaluatorId !== 'string') {
    return res.status(400).json({ error: 'evaluatorId must be a string' });
  }
  if (service !== undefined && typeof service !== 'string') {
    return res.status(400).json({ error: 'service must be a string' });
  }
  if (userFeedback !== undefined && typeof userFeedback !== 'string') {
    return res.status(400).json({ error: 'userFeedback must be a string' });
  }

  const resolvedEvaluatorId = evaluatorId || DEFAULT_EVALUATOR_ID;
  const evaluator = await resolveEvaluator(resolvedEvaluatorId);
  if (!evaluator) {
    return res.status(404).json({ error: `Evaluator not found: ${resolvedEvaluatorId}` });
  }

  const obs = getObservabilityClient(req);
  if (!obs) {
    return res.status(503).json({
      error: 'No observability cluster configured. Set up telemetry (see: agent-health setup-telemetry).',
    });
  }

  let spans: Span[];
  try {
    const result = await fetchTraces(
      { sessionId, size: MAX_SESSION_SPANS },
      obs.client,
      obs.indexes.traces,
    );
    spans = (result.spans || []) as Span[];
  } catch (err: any) {
    debug('ProfileAPI', 'fetchTraces failed:', err?.message);
    return res.status(502).json({ error: `Failed to fetch session traces: ${err?.message ?? String(err)}` });
  }

  if (spans.length === 0) {
    return res.status(404).json({
      error: `No spans found for session ${sessionId}. Is telemetry flowing?`,
      sessionId,
    });
  }

  const profile = buildProfile(sessionId, spans, evaluator, { service, userFeedback });
  return res.json(profile);
});

export default router;
