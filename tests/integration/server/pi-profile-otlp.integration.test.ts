/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: pi profiling extension → OTLP receiver → trajectory.
 *
 * Proves the END-TO-END contract that makes `agent-health profile` work for pi,
 * using the SAME span builders the distribution extension
 * (examples/pi-profiling/agent-health-profile.ts) emits at runtime:
 *
 *   extension OTLP span builders
 *      → buildOtlpPayload
 *      → POST /v1/traces  (the embedded receiver the extension exports to)
 *      → on-disk file TraceStore
 *      → POST /api/traces { sessionId }   (exact-match on attributes['session.id'])
 *      → spansToTrajectory / scanSessionSignals (the profiling consumer)
 *
 * If the extension's emitted span shape ever drifts from what the profiling
 * pipeline consumes, this test fails. No mocks, no OpenSearch — file mode in a
 * throwaway temp dir.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import tracesRoutes from '@/server/routes/traces';
import { spansToTrajectory, scanSessionSignals } from '@/services/traces/spansToTrajectory';
import {
  PI_SERVICE_NAME,
  buildOtlpPayload,
  buildRootSpan,
  buildChatSpan,
  buildToolSpan,
  genTraceId,
  genSpanId,
  msToNanos,
  type OtlpSpan,
} from '../../../examples/pi-profiling/agent-health-profile';

const SESSION_ID = 'pi-int-session-1';

/**
 * Build the spans a real pi session would emit: a root invoke_agent span, a
 * first chat turn (user prompt + completion), a tool call that FAILS, then a
 * retry of the same tool — exactly the shape the extension produces.
 */
function piSessionSpans(): OtlpSpan[] {
  const traceId = genTraceId();
  const rootId = genSpanId();
  let t = 1_000;
  const times = () => { const startMs = t; t += 1_000; return { startNs: msToNanos(startMs), endNs: msToNanos(t) }; };
  return [
    buildRootSpan({ traceId, spanId: rootId, sessionId: SESSION_ID, times: { startNs: msToNanos(1_000), endNs: msToNanos(9_000) } }),
    buildChatSpan({ traceId, spanId: genSpanId(), parentSpanId: rootId, sessionId: SESSION_ID, times: times(), model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, userPrompt: 'Why is the checkout service throwing 500s?', completion: 'Let me search the logs.' }),
    buildToolSpan({ traceId, spanId: genSpanId(), parentSpanId: rootId, sessionId: SESSION_ID, times: times(), toolName: 'search_logs', input: { q: 'checkout 500' }, output: 'error: timeout', isError: true }),
    buildToolSpan({ traceId, spanId: genSpanId(), parentSpanId: rootId, sessionId: SESSION_ID, times: times(), toolName: 'search_logs', input: { q: 'checkout 500 retry' }, output: 'found root cause' }),
  ];
}

describe('pi profiling extension → profile pipeline (integration)', () => {
  let app: Express;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-profile-int-'));
    for (const k of OBS_ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
    process.env.AGENT_HEALTH_DATA_DIR = dir;

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(otlpReceiverRoutes);
    app.use(tracesRoutes);
  });

  afterAll(async () => {
    for (const k of OBS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ingests pi spans and returns them by session.id (exact match)', async () => {
    await request(app).post('/v1/traces').send(buildOtlpPayload(PI_SERVICE_NAME, piSessionSpans())).expect(200);

    const res = await request(app).post('/api/traces').send({ sessionId: SESSION_ID }).expect(200);
    expect(res.body.backend).toBe('file');
    const spans = res.body.spans;
    expect(spans.length).toBe(4);
    expect(spans.every((s: any) => s.attributes['session.id'] === SESSION_ID)).toBe(true);
    expect(spans.every((s: any) => s.attributes['service.name'] === PI_SERVICE_NAME)).toBe(true);
  });

  it('reconstructs a coherent trajectory (user → assistant → tool calls)', async () => {
    const res = await request(app).post('/api/traces').send({ sessionId: SESSION_ID }).expect(200);
    const trajectory = spansToTrajectory(res.body.spans, 'pi-agent');
    const types = trajectory.map(s => s.type);
    expect(types).toContain('thinking');   // user prompt
    expect(types).toContain('assistant');  // completion
    expect(types).toContain('action');     // tool calls
    expect(types).toContain('tool_result');
    expect(trajectory.find(s => s.type === 'thinking')?.content).toContain('Why is the checkout service throwing 500s?');
    expect(trajectory.find(s => s.type === 'action')?.toolName).toBe('search_logs');
  });

  it('scans signals: a failed tool that was retried surfaces tool_error_retry', async () => {
    const res = await request(app).post('/api/traces').send({ sessionId: SESSION_ID }).expect(200);
    const signals = scanSessionSignals(res.body.spans, 'pi-agent');
    expect(signals.some(s => s.id === 'tool_error_retry')).toBe(true);
  });
});
