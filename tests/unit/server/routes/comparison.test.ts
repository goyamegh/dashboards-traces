/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockLoadConfigSync = jest.fn();
const mockRunsGetById = jest.fn();
const mockGenerateComparisonDeepDive = jest.fn();
const mockDebug = jest.fn();

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: (...args: any[]) => mockLoadConfigSync(...args),
}));

jest.mock('@/server/adapters', () => ({
  getStorageModule: jest.fn(() => ({
    runs: {
      getById: (...args: any[]) => mockRunsGetById(...args),
    },
  })),
}));

jest.mock('@/server/services/comparisonDeepDiveService', () => ({
  generateComparisonDeepDive: (...args: any[]) => mockGenerateComparisonDeepDive(...args),
}));

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

import express, { Application } from 'express';
const request = require('supertest');
import comparisonRouter from '@/server/routes/comparison';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(comparisonRouter);
  return app;
}

describe('Comparison routes', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when reportIds is not exactly two strings', async () => {
    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['only-one'] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'reportIds must be an array of exactly 2 report id strings',
    });
  });

  it('returns 404 when one or more reports are missing', async () => {
    mockRunsGetById
      .mockResolvedValueOnce({ id: 'report-a' })
      .mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'report(s) not found: report-b',
    });
  });

  it('builds deep-dive inputs from reports using configured and protocol-derived service names', async () => {
    mockLoadConfigSync.mockReturnValue({
      agents: [{ key: 'agent-a', traceServiceName: 'custom-a' }],
    });
    mockRunsGetById.mockImplementation(async (id: string) => ({
      'report-a': {
        id: 'report-a',
        agentKey: 'agent-a',
        agentName: 'Agent A',
        runId: 'run-a',
        timestamp: '2024-01-01T00:00:00.000Z',
        performanceMetrics: { durationMs: 5000 },
        passFailStatus: 'passed',
        metrics: { accuracy: 91 },
        finalOutput: 'Final output A',
        trajectory: [{ type: 'action', toolName: 'search_logs' }],
      },
      'report-b': {
        id: 'report-b',
        agentKey: 'agent-b',
        connectorProtocol: 'pi',
        runId: 'run-b',
        timestamp: '2024-01-01T00:10:00.000Z',
        passFailStatus: 'failed',
        metrics: { accuracy: 12 },
        output: 'Output B',
        trajectory: [{ type: 'action', toolName: 'inspect_metrics' }],
      },
    }[id]));
    mockGenerateComparisonDeepDive.mockResolvedValue({
      markdown: 'analysis',
      modelId: 'judge-1',
      durationMs: 88,
    });

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'], modelId: 'judge-1' });

    expect(res.status).toBe(200);
    expect(mockGenerateComparisonDeepDive).toHaveBeenCalledWith({
      modelId: 'judge-1',
      runs: [
        {
          key: 'A',
          label: 'Agent A',
          runId: 'run-a',
          agents: [{
            serviceName: 'custom-a',
            startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000,
            endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000,
          }],
          passFailStatus: 'passed',
          accuracy: 91,
          toolNames: ['search_logs'],
          durationMs: 5000,
          finalOutput: 'Final output A',
        },
        {
          key: 'B',
          label: 'agent-b',
          runId: 'run-b',
          agents: [{
            serviceName: 'pi-agent',
            startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000,
            endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000,
          }],
          passFailStatus: 'failed',
          accuracy: 12,
          toolNames: ['inspect_metrics'],
          durationMs: undefined,
          finalOutput: 'Output B',
        },
      ],
    });
    expect(res.body).toEqual({
      markdown: 'analysis',
      modelId: 'judge-1',
      durationMs: 88,
      runs: [
        {
          key: 'A',
          reportId: 'report-a',
          runId: 'run-a',
          serviceName: 'custom-a',
          startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000,
          endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000,
        },
        {
          key: 'B',
          reportId: 'report-b',
          runId: 'run-b',
          serviceName: 'pi-agent',
          startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000,
          endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000,
        },
      ],
    });
  });

  it('falls back to env-based and agentKey-derived service names and trajectory-derived final output', async () => {
    mockLoadConfigSync.mockReturnValue({
      agents: [{ key: 'agent-env', connectorConfig: { env: { OTEL_SERVICE_NAME: 'env-service' } } }],
    });
    mockRunsGetById.mockImplementation(async (id: string) => ({
      'report-a': {
        id: 'report-a',
        agentKey: 'agent-env',
        timestamp: '2024-01-01T01:00:00.000Z',
        trajectory: [{ type: 'response', content: 'from trajectory A' }],
      },
      'report-b': {
        id: 'report-b',
        agentKey: 'orphan',
        timestamp: '2024-01-01T02:00:00.000Z',
        trajectory: [{ type: 'assistant', content: 'noise' }, { type: 'response', output: 'from trajectory B' }],
      },
    }[id]));
    mockGenerateComparisonDeepDive.mockResolvedValue({ markdown: 'ok', modelId: 'judge-2', durationMs: 1 });

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'] });

    expect(res.status).toBe(200);
    expect(mockGenerateComparisonDeepDive).toHaveBeenCalledWith({
      modelId: undefined,
      runs: [
        expect.objectContaining({
          key: 'A',
          label: 'agent-env',
          agents: [{
            serviceName: 'env-service',
            startedAt: Date.parse('2024-01-01T01:00:00.000Z') - 1800000,
            endedAt: Date.parse('2024-01-01T01:00:00.000Z') + 1800000,
          }],
          finalOutput: 'from trajectory A',
        }),
        expect.objectContaining({
          key: 'B',
          label: 'orphan',
          agents: [{
            serviceName: 'orphan-agent',
            startedAt: Date.parse('2024-01-01T02:00:00.000Z') - 1800000,
            endedAt: Date.parse('2024-01-01T02:00:00.000Z') + 1800000,
          }],
          finalOutput: 'from trajectory B',
        }),
      ],
    });
  });

  it('returns 500 when deep-dive generation throws', async () => {
    mockLoadConfigSync.mockReturnValue({ agents: [] });
    mockRunsGetById.mockResolvedValue({ id: 'report-a', timestamp: '2024-01-01T00:00:00.000Z' });
    mockGenerateComparisonDeepDive.mockRejectedValue(new Error('judge unavailable'));

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-a'] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'judge unavailable' });
    expect(console.error).toHaveBeenCalledWith('[CompareDeepDiveAPI] error:', expect.any(Error));
  });
});
