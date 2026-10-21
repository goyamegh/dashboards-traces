/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask routes — "highlight & ask" (prototype).
 *
 *   POST /api/ask                 SSE: meta → delta* / tool* → done | error
 *   GET  /api/ask/agents          agents the UI may pick (builtin + chat-capable agents[])
 *   GET  /api/ask/sessions        list ask sessions (?route= filters to one page)
 *   GET  /api/ask/sessions/:id    one session with all turns
 */

import { Router, Request, Response } from 'express';
import { loadConfigSync } from '@/lib/config/index';
import { debug } from '@/lib/debug';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { streamAsk, resolveAskAgentForRequest, type AskRequest } from '@/server/services/ask/askService';
import { AskAgentResolutionError, listAskAgents } from '@/server/services/ask/askAgentResolver';
import { getAskSessionStore } from '@/server/services/ask/askSessionStore';

const router = Router();

function validate(body: any): string | null {
  if (!body || typeof body !== 'object') return 'Request body must be an object';
  if (typeof body.question !== 'string' || !body.question.trim()) return 'question is required';
  if (body.question.length > 8_000) return 'question is too long (max 8000 chars)';
  if (!body.pageContext || typeof body.pageContext.route !== 'string') return 'pageContext.route is required';
  if (body.selections !== undefined) {
    if (!Array.isArray(body.selections)) return 'selections must be an array';
    if (body.selections.length > 20) return 'too many selections (max 20)';
    for (const s of body.selections) {
      if (!s || typeof s.text !== 'string') return 'each selection needs a text string';
      if (s.text.length > 20_000) return 'a selection is too long (max 20000 chars)';
    }
  }
  if (body.agentKey !== undefined && typeof body.agentKey !== 'string') return 'agentKey must be a string';
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return 'sessionId must be a string';
  return null;
}

router.post('/api/ask', (req: Request, res: Response) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as AskRequest;
  // Resolve the agent BEFORE opening the stream so a bad key is a plain 400.
  try {
    resolveAskAgentForRequest(body.agentKey);
  } catch (e: any) {
    if (e instanceof AskAgentResolutionError) return res.status(400).json({ error: e.message, code: e.code });
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
  debug('AskAPI', 'question:', body.question.slice(0, 80), 'route:', body.pageContext.route, 'agent:', body.agentKey ?? '(default)');

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

router.get('/api/ask/agents', (_req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    let custom: ReturnType<typeof getCustomAgents> = [];
    try { custom = getCustomAgents(); } catch { /* custom agent store unavailable */ }
    const agents = listAskAgents({ agents: [...config.agents, ...custom], assistant: config.assistant }).map((a) => ({
      key: a.key, name: a.name, connectorType: a.connectorType, isDefault: a.isDefault, kind: a.kind,
    }));
    res.json({ agents, configuredDefault: config.assistant?.agentKey ?? null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/ask/sessions', (req: Request, res: Response) => {
  const route = typeof req.query.route === 'string' ? req.query.route : undefined;
  const limit = typeof req.query.limit === 'string' ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200)) : undefined;
  res.json({ sessions: getAskSessionStore().list({ route, limit }) });
});

router.get('/api/ask/sessions/:id', (req: Request, res: Response) => {
  const session = getAskSessionStore().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Ask session not found' });
  res.json({ session });
});

export default router;
