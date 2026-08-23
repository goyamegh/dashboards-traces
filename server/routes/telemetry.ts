/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';

const router = Router();

/**
 * POST /api/telemetry/ui-event — fire-and-forget UI usage event sink.
 *
 * Lets us understand load/usage patterns (which search scope users pick, how
 * often, result counts, etc.) without a heavyweight analytics dependency.
 * Events are written as a single structured log line so a collector can
 * tail/aggregate them; no storage is allocated here.
 *
 * Body: { event: string, props?: Record<string, unknown> }
 */
router.post('/api/telemetry/ui-event', (req: Request, res: Response) => {
  const { event, props } = req.body || {};
  if (typeof event !== 'string' || event.length === 0 || event.length > 128) {
    return res.status(400).json({ error: 'event must be a non-empty string (<=128 chars)' });
  }
  // Single bounded structured line — cheap, greppable, collector-friendly.
  console.log(
    '[ui-telemetry]',
    JSON.stringify({
      event,
      props: props && typeof props === 'object' ? props : undefined,
      ts: new Date().toISOString(),
    })
  );
  res.status(204).end();
});

export default router;
