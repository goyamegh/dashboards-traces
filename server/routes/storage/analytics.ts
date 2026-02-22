/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Analytics Routes - Read-only queries and aggregations
 *
 * Storage-backend agnostic: uses IStorageModule adapter (file or OpenSearch).
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '../../adapters/index.js';

const router = Router();

// GET /api/storage/analytics - Query with filters
router.get('/api/storage/analytics', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    if (!storage.isConfigured()) {
      return res.json({ records: [], total: 0 });
    }

    const { experimentId, testCaseId, agentId, modelId, passFailStatus, size = '1000', from = '0' } = req.query;

    const filters: Record<string, unknown> = {};
    if (experimentId) filters.experimentId = experimentId;
    if (testCaseId) filters.testCaseId = testCaseId;
    if (agentId) filters.agentId = agentId;
    if (modelId) filters.modelId = modelId;
    if (passFailStatus) filters.passFailStatus = passFailStatus;

    const result = await storage.analytics.query(filters, {
      size: parseInt(size as string),
      from: parseInt(from as string),
    });

    res.json({ records: result.items, total: result.total });
  } catch (error: any) {
    console.error('[StorageAPI] Analytics query failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/analytics/aggregations - Aggregated metrics
router.get('/api/storage/analytics/aggregations', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    if (!storage.isConfigured()) {
      return res.json({ aggregations: [], groupBy: req.query.groupBy || 'agentId' });
    }

    const { experimentId, groupBy = 'agentId' } = req.query;
    const result = await storage.analytics.aggregations(
      experimentId as string | undefined,
      groupBy as string,
    );

    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Analytics aggregations failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/analytics/search - Complex search with custom aggs
router.post('/api/storage/analytics/search', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    if (!storage.isConfigured()) {
      return res.json({ records: [], total: 0, aggregations: {} });
    }

    const { filters, size = 1000, from = 0 } = req.body;

    const result = await storage.analytics.query(filters || {}, { size, from });

    res.json({ records: result.items, total: result.total, aggregations: {} });
  } catch (error: any) {
    console.error('[StorageAPI] Analytics search failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
