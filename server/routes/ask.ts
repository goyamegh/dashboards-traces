/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask routes — the Agent Health assistant ("highlight & ask").
 *
 *   POST /api/ask                 SSE: meta → delta* / tool* → done | error
 *   POST /api/ask/prepare         build the page snapshot + create the pi session early → { sessionId }
 *   GET  /api/ask/sessions        list ask sessions (pi sessions; ?route= filters to one page)
 *   GET  /api/ask/sessions/:id    one session with all turns
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { streamAsk, prepareAsk, getAskSessionStore, type AskRequest } from '@/server/services/ask/askService';

const router = Router();

function validatePage(body: any): string | null {
  if (!body || typeof body !== 'object') return 'Request body must be an object';
  if (!body.pageContext || typeof body.pageContext.route !== 'string') return 'pageContext.route is required';
  if (body.selections !== undefined) {
    if (!Array.isArray(body.selections)) return 'selections must be an array';
    if (body.selections.length > 20) return 'too many selections (max 20)';
    for (const s of body.selections) {
      if (!s || typeof s.text !== 'string') return 'each selection needs a text string';
      if (s.text.length > 20_000) return 'a selection is too long (max 20000 chars)';
    }
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return 'sessionId must be a string';
  return null;
}

function validateAsk(body: any): string | null {
  const base = validatePage(body);
  if (base) return base;
  if (typeof body.question !== 'string' || !body.question.trim()) return 'question is required';
  if (body.question.length > 8_000) return 'question is too long (max 8000 chars)';
  return null;
}

router.post('/api/ask', (req: Request, res: Response) => {
  const err = validateAsk(req.body);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as AskRequest;
  debug('AskAPI', 'question:', body.question.slice(0, 80), 'route:', body.pageContext.route, 'session:', body.sessionId ?? '(new)');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let ended = false;
  const send = (ev: Record<string, unknown>) => { if (!ended) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const keepalive = setInterval(() => { if (!ended) res.write(': ping\n\n'); }, 15_000);
  if (keepalive.unref) keepalive.unref();
  const finish = () => { if (ended) return; ended = true; clearInterval(keepalive); res.end(); };

  const handle = streamAsk(body, {
    onMeta: (meta) => send({ type: 'meta', ...meta }),
    onDelta: (content) => send({ type: 'delta', content }),
    onTool: (tool) => send({ type: 'tool', ...tool }),
    onDone: (result) => { send({ type: 'done', ...result }); finish(); },
    onError: (error) => { send({ type: 'error', error }); finish(); },
  });

  req.on('close', () => {
    if (!ended) { ended = true; clearInterval(keepalive); handle.abort(); }
  });
});

router.post('/api/ask/prepare', async (req: Request, res: Response) => {
  const err = validatePage(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await prepareAsk({ pageContext: req.body.pageContext, selections: req.body.selections, modelId: req.body.modelId });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

router.get('/api/ask/sessions', async (req: Request, res: Response) => {
  try {
    const route = typeof req.query.route === 'string' ? req.query.route : undefined;
    const limit = typeof req.query.limit === 'string' ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200)) : undefined;
    const store = await getAskSessionStore();
    res.json({ sessions: store.list({ route, limit }), dir: store.dir });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

router.get('/api/ask/sessions/:id', async (req: Request, res: Response) => {
  try {
    const session = (await getAskSessionStore()).get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Ask session not found' });
    res.json({ session });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
