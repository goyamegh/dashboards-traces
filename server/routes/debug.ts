/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Debug Routes - Runtime toggle for verbose logging
 */

import { Router, Request, Response } from 'express';
import { isDebugEnabled, setDebugEnabled } from '../../lib/debug';

const router = Router();

// GET /api/debug - Check current debug state
router.get('/api/debug', (_req: Request, res: Response) => {
  res.json({ enabled: isDebugEnabled() });
});

// POST /api/debug - Toggle debug mode
router.post('/api/debug', (req: Request, res: Response) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  setDebugEnabled(enabled);
  res.json({ enabled: isDebugEnabled() });
});

export default router;
